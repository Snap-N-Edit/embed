import type { EditorMethod, EmbedEventName, EmbedEvents, EmbedErrorCode, FrameConfig } from './types.js';

export const PROTOCOL_VERSION = 1 as const;
export const EMBED_PATH = '/embed';
export const DEFAULT_EMBED_ORIGIN = 'https://snapnedit.com';

export type HostToFrameMessage =
  | { snapnedit: 1; type: 'init'; payload: { config: FrameConfig } }
  | { snapnedit: 1; type: 'call'; id: string; payload: { method: EditorMethod; args: unknown[] } }
  | { snapnedit: 1; type: 'refresh-token'; payload: { token: string } };

export type FrameToHostMessage =
  | { snapnedit: 1; type: 'ready-for-init' }
  | { snapnedit: 1; type: 'event'; payload: { name: EmbedEventName; data: EmbedEvents[EmbedEventName] } }
  | { snapnedit: 1; type: 'result'; id: string; payload: { ok: true; value: unknown } | { ok: false; error: ProtocolError } };

/**
 * A failure as it crosses postMessage. `details` is optional so an OLDER
 * frame — which never sends it — stays a valid message: the loader rebuilds
 * an `EmbedError` with no details, exactly as before.
 */
export interface ProtocolError { code: EmbedErrorCode; message: string; details?: Record<string, unknown> }

/**
 * The `invalid_input` message the FRAME answers a method it does not
 * implement with. It lives here, in the package both sides share, so the
 * loader can RECOGNIZE it: a newer loader calling a method an older `/embed`
 * has never heard of gets this back, and turns it into the far more useful
 * `unsupported` (see {@link isUnknownMethodError}) instead of surfacing a
 * generic "invalid input" for a perfectly valid call.
 */
export function unknownMethodMessage(method: string): string {
  return `unknown method ${String(method)}`;
}

/** True when `error` is an older frame's "I have never heard of `method`" answer. */
export function isUnknownMethodError(error: ProtocolError, method: string): boolean {
  return error.code === 'invalid_input' && error.message === unknownMethodMessage(method);
}

export type ProtocolMessage = HostToFrameMessage | FrameToHostMessage;

export function isProtocolMessage(data: unknown): data is ProtocolMessage {
  return typeof data === 'object' && data !== null
    && (data as { snapnedit?: unknown }).snapnedit === PROTOCOL_VERSION
    && typeof (data as { type?: unknown }).type === 'string';
}

/** Browser-enforced trust: the message must come from exactly the window AND origin we expect. */
export function isTrustedEvent(event: MessageEvent, expectedSource: unknown, expectedOrigin: string): boolean {
  return event.source === expectedSource && event.origin === expectedOrigin;
}

/**
 * A `{}`-literal (or `Object.create(null)`) object — NOT a `Blob`, `File`,
 * `Date`, `ArrayBuffer`, typed array or any other class instance, all of which
 * structured clone handles natively and must cross the boundary untouched.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const already = seen.get(value);
    if (already !== undefined) return already;
    const out: unknown[] = [];
    seen.set(value, out);
    // A function INSIDE an array becomes `null` rather than vanishing: dropping
    // it would renumber every later index, which is worse than a visible hole.
    for (const item of value) out.push(typeof item === 'function' ? null : stripValue(item, seen));
    return out;
  }
  if (isPlainObject(value)) {
    const already = seen.get(value);
    if (already !== undefined) return already;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'function') out[k] = stripValue(v, seen);
    }
    return out;
  }
  return value;
}

/**
 * Deep-copies `value` without any function-valued property, so the result is
 * structured-cloneable and `postMessage` cannot throw a DataCloneError.
 *
 * Plain objects and arrays are walked recursively (a nested `getToken`-shaped
 * callback anywhere in the config used to surface as a 60s boot timeout);
 * everything else — `Blob`, `File`, `Date`, `ArrayBuffer`, typed arrays, class
 * instances — is passed through by reference, since those clone natively and
 * copying them would corrupt them. Shared references and cycles are preserved.
 */
export function stripFunctions<T extends object>(value: T): T {
  return stripValue(value, new Map<object, unknown>()) as T;
}

let counter = 0;
export function newRequestId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function embedFrameUrl(embedOrigin: string, hostOrigin: string): string {
  return `${embedOrigin.replace(/\/+$/, '')}${EMBED_PATH}?host=${encodeURIComponent(hostOrigin)}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * The machine-readable surface: every method, event and error code as a
 * RUNTIME list, so `protocol.json` (and any wrapper generated from it) can be
 * checked against the types rather than hand-maintained beside them.
 *
 * The lists are declared here rather than derived from `types.ts` because
 * `EditorMethod` / `EmbedEventName` / `EmbedErrorCode` are types with no
 * runtime residue. `Exhaustive<…>` below is what keeps them honest: adding a
 * method to `EditorHandle` without adding it here is a COMPILE error, and
 * adding one here that is not a real method is too (`satisfies`).
 * ──────────────────────────────────────────────────────────────────────── */

/** Compile-time assertion that `T` is `never` — i.e. nothing was left off a list. */
type Exhaustive<T extends never> = T;

/** Every `EditorHandle` method forwarded to the frame as a `call`, in the order they are documented. */
export const EDITOR_METHODS = [
  'loadImage',
  'addImage',
  'loadDocument',
  'getDocument',
  'getPages',
  'newDocument',
  'export',
  'exportTo',
  'listDestinations',
  'run',
  'openTool',
  'undo',
  'redo',
  'select',
  'getState',
  'setTheme',
  'setFeatures',
  'setLocale',
] as const satisfies readonly EditorMethod[];

/** @internal Compile-time proof that {@link EDITOR_METHODS} lists every {@link EditorMethod}. */
export type EditorMethodsAreExhaustive = Exhaustive<Exclude<EditorMethod, (typeof EDITOR_METHODS)[number]>>;

/**
 * The methods a host should allow far more than {@link https://snapnedit.com/docs/embed | the default call timeout}
 * for — they render, upload or run a model. Mirrors `mount.ts`'s `LONG_CALLS`
 * and is what `protocol.json` reports as `longRunning`.
 */
export const LONG_RUNNING_METHODS = ['export', 'exportTo', 'run', 'loadImage', 'addImage'] as const satisfies readonly EditorMethod[];

/** Every event the frame emits to the host. */
export const EMBED_EVENT_NAMES = [
  'ready',
  'change',
  'selection',
  'job',
  'export',
  'save',
  'close',
  'error',
  'token-expiring',
] as const satisfies readonly EmbedEventName[];

/** @internal Compile-time proof that {@link EMBED_EVENT_NAMES} lists every {@link EmbedEventName}. */
export type EmbedEventNamesAreExhaustive = Exhaustive<Exclude<EmbedEventName, (typeof EMBED_EVENT_NAMES)[number]>>;

/**
 * Every code a {@link ProtocolError} can carry — the api's own `ErrorCode`s
 * followed by the embed-only lifecycle ones.
 *
 * Spelled out rather than imported from `@snapnedit/shared`: this package
 * has ZERO runtime dependencies (it ships to third-party pages), so
 * `@snapnedit/shared` may only ever be a `import type`. `Exhaustive` below is
 * what stops the copy from drifting — a new `ErrorCode` upstream fails this
 * package's build until it is listed here.
 */
export const EMBED_ERROR_CODES = [
  'invalid_input',
  'unsupported_mime',
  'too_large',
  'not_found',
  'input_fetch_failed',
  'provider_failed',
  'provider_exhausted',
  'rate_limited',
  'bot_check_failed',
  'unauthorized',
  'forbidden',
  'payment_required',
  'internal',
  'not_ready',
  'mask_required',
  'timeout',
  'origin_denied',
  'destroyed',
  'token_expired',
  'network_error',
  'upload_failed',
  'unsupported',
] as const satisfies readonly EmbedErrorCode[];

/** @internal Compile-time proof that {@link EMBED_ERROR_CODES} lists every {@link EmbedErrorCode}. */
export type EmbedErrorCodesAreExhaustive = Exhaustive<Exclude<EmbedErrorCode, (typeof EMBED_ERROR_CODES)[number]>>;

/* ────────────────────────────────────────────────────────────────────────
 * Native transport (`docs/embed-protocol.md`, /docs/embed-native)
 *
 * The SAME envelopes, serialized as JSON strings, over whatever channel the
 * shell's webview offers instead of `postMessage`. Nothing about the protocol
 * changes — only who carries the bytes — so a wrapper written against
 * `protocol.json` implements one message set for both transports.
 * ──────────────────────────────────────────────────────────────────────── */

/** How the frame and its host exchange {@link ProtocolMessage}s. */
export type EmbedTransport = 'postMessage' | 'native';

export const EMBED_TRANSPORTS = ['postMessage', 'native'] as const satisfies readonly EmbedTransport[];

/** `?transport=native` — what puts the frame on the native transport. */
export const NATIVE_TRANSPORT: EmbedTransport = 'native';

/** The global the frame installs for the shell to push messages IN through: `window.SnapneditNativeBridge.receive(json)`. */
export const NATIVE_BRIDGE_GLOBAL = 'SnapneditNativeBridge';

/**
 * The channel/handler NAME a shell registers, identical on every platform:
 * `WKScriptMessageHandler` name, Android `@JavascriptInterface` object, and
 * `flutter_inappwebview` handler are all `snapnedit`; `webview_flutter`'s
 * `JavaScriptChannel` is `Snapnedit` (Dart channel names are used verbatim as
 * a JS global, so it is capitalized to read like one).
 */
export const NATIVE_CHANNEL_NAME = 'snapnedit';
export const NATIVE_FLUTTER_CHANNEL_NAME = 'Snapnedit';

/** The query parameters `/embed?transport=native&…` understands. */
export const NATIVE_QUERY_PARAMS = ['transport', 'origin', 'key', 'token', 'locale'] as const;

/**
 * Every outbound channel the frame probes, IN ORDER, to hand a serialized
 * envelope to the shell. The first one present wins; a sink installed with
 * `SnapneditNativeBridge.setSink(fn)` pre-empts all of them.
 */
export const NATIVE_OUTBOUND_CHANNELS = [
  { id: 'wkwebview', expression: 'window.webkit.messageHandlers.snapnedit.postMessage(json)' },
  { id: 'webview2', expression: 'window.chrome.webview.postMessage(json)' },
  { id: 'android', expression: 'window.SnapneditAndroid.postMessage(json)' },
  { id: 'flutter-inappwebview', expression: "window.flutter_inappwebview.callHandler('snapnedit', json)" },
  { id: 'flutter-channel', expression: 'window.Snapnedit.postMessage(json)' },
  { id: 'sink', expression: 'window.SnapneditNativeBridge.setSink(fn)' },
] as const;

export type NativeChannelId = (typeof NATIVE_OUTBOUND_CHANNELS)[number]['id'];
