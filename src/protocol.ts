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
  | { snapnedit: 1; type: 'result'; id: string; payload: { ok: true; value: unknown } | { ok: false; error: { code: EmbedErrorCode; message: string } } };

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
