import { DEFAULT_EMBED_ORIGIN, embedFrameUrl, isProtocolMessage, isTrustedEvent, newRequestId, stripFunctions, type FrameToHostMessage, type HostToFrameMessage } from './protocol.js';
import { EmbedError, type EditorHandle, type EditorMethod, type EmbedConfig, type EmbedEventName, type EmbedEvents } from './types.js';

export const CALL_TIMEOUT_MS = 30_000;
export const LONG_CALL_TIMEOUT_MS = 180_000;
/** Token-refresh backoff: 1s, 2s, 4s … capped at 30s. See `onTokenExpiring`. */
export const TOKEN_RETRY_BASE_MS = 1_000;
export const TOKEN_RETRY_MAX_MS = 30_000;
const LONG_CALLS: ReadonlySet<EditorMethod> = new Set<EditorMethod>(['export', 'run', 'loadImage', 'addImage']);
const METHODS: readonly EditorMethod[] = ['loadImage', 'addImage', 'loadDocument', 'getDocument', 'getPages', 'newDocument', 'export', 'run', 'openTool', 'undo', 'redo', 'select', 'getState', 'setTheme', 'setFeatures', 'setLocale'];

/** The slice of `window`/`document` `mount` touches — injectable so the whole handshake is unit-testable without a DOM. */
export interface WindowLike {
  location: { origin: string };
  addEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}
export interface DocumentLike {
  createElement(tag: 'iframe'): HTMLIFrameElement;
  querySelector(selector: string): Element | null;
}
export interface MountDeps { window?: WindowLike; document?: DocumentLike }

type Pending = { resolve: (v: unknown) => void; reject: (e: EmbedError) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Mounts the snapnedit editor into `target` as an iframe and returns a typed
 * handle. Resolves once the frame reports `ready`; rejects with `EmbedError`
 * on a config error, an `origin_denied`/auth failure, or a 60s boot timeout.
 */
export function mount(target: HTMLElement | string, config: EmbedConfig, deps: MountDeps = {}): Promise<EditorHandle> {
  const win = deps.window ?? (globalThis.window as unknown as WindowLike);
  const doc = deps.document ?? (globalThis.document as unknown as DocumentLike);
  if (!config.publishableKey && !config.token && !config.getToken) {
    return Promise.reject(new EmbedError('invalid_input', 'mount(): provide publishableKey, token, or getToken'));
  }
  const container = typeof target === 'string' ? (doc.querySelector(target) as HTMLElement | null) : target;
  if (!container) return Promise.reject(new EmbedError('invalid_input', `mount(): target not found: ${String(target)}`));

  const embedOrigin = (config.origin ?? DEFAULT_EMBED_ORIGIN).replace(/\/+$/, '');
  const iframe = doc.createElement('iframe');
  iframe.src = embedFrameUrl(embedOrigin, win.location.origin);
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  iframe.setAttribute('title', 'snapnedit editor');
  Object.assign(iframe.style, { width: '100%', height: '100%', border: '0', display: 'block' });
  container.appendChild(iframe);

  const pending = new Map<string, Pending>();
  const listeners = new Map<EmbedEventName, Set<(payload: never) => void>>();
  let destroyed = false;
  let initSent = false;
  let readyResolve: ((h: EditorHandle) => void) | null = null;
  let readyReject: ((e: EmbedError) => void) | null = null;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The `ready` payload, kept after it fires. `ready` is a one-shot lifecycle
   * event that has ALREADY happened by the time `mount()`'s promise resolves,
   * so the natural `const h = await mount(...); h.on('ready', …)` would
   * otherwise register a listener that can never be called. Replaying it
   * synchronously on registration makes `on('ready')` work regardless of
   * ordering; every other event stays purely live (they recur).
   */
  let readyPayload: EmbedEvents['ready'] | null = null;

  const post = (msg: HostToFrameMessage): void => {
    iframe.contentWindow?.postMessage(msg, embedOrigin);
  };

  /**
   * One host listener must never take down the bus: a throw here would skip
   * every later listener for the same event AND propagate out of the `message`
   * handler (or out of `on()`, for the `ready` replay). Report it and carry on.
   */
  const invokeListener = <E extends EmbedEventName>(name: E, cb: (p: EmbedEvents[E]) => void, data: EmbedEvents[E]): void => {
    try {
      cb(data);
    } catch (err) {
      console.error(`[snapnedit embed] ${name} listener threw`, err);
    }
  };

  const emitLocal = <E extends EmbedEventName>(name: E, data: EmbedEvents[E]): void => {
    // Snapshot: a listener that un/subscribes during dispatch must not mutate
    // the set being iterated.
    for (const cb of [...(listeners.get(name) ?? [])]) invokeListener(name, cb as (p: EmbedEvents[E]) => void, data);
  };

  /** Full teardown shared by an early boot failure (timeout / pre-ready `error`) and `handle.destroy()`: stop listening, fail any pending calls, and remove the iframe so an abandoned frame can never trigger another `init` (which would resend the real token/publishableKey). Idempotent. */
  const teardown = (): void => {
    if (destroyed) return;
    destroyed = true;
    win.removeEventListener('message', onMessage);
    // A `destroy()` before `ready` would otherwise leave the 60s boot timer
    // armed, holding the (Node) event loop open and firing against a frame
    // that no longer exists.
    if (bootTimer !== null) { win.clearTimeout(bootTimer); bootTimer = null; }
    // Same for the token-refresh/expiry ticker, and drop the replay buffer so a
    // destroyed handle can't hand a stale `ready` to a listener registered after.
    clearRefreshTimer();
    readyPayload = null;
    for (const p of pending.values()) { win.clearTimeout(p.timer); p.reject(new EmbedError('destroyed', 'editor was destroyed')); }
    pending.clear();
    iframe.remove();
  };

  // --- token refresh -------------------------------------------------------
  // The frame re-arms its expiry clock on a 1s floor, so an already-expired
  // token makes it report `token-expiring` EVERY SECOND for as long as the
  // condition lasts. Handling each one immediately turned that into a 1/s
  // hammer on the host's `getToken` endpoint (and a 1/s event storm); instead
  // the first one is reported and the retries are spaced out exponentially.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInFlight = false;
  let refreshBackoffMs = 0;
  let tokenExpiredEmitted = false;

  const clearRefreshTimer = (): void => {
    if (refreshTimer !== null) { win.clearTimeout(refreshTimer); refreshTimer = null; }
  };
  const armRefreshTimer = (delay: number, fn: () => void): void => {
    clearRefreshTimer();
    refreshTimer = win.setTimeout(() => { refreshTimer = null; fn(); }, delay);
  };
  const nextBackoff = (): number => {
    refreshBackoffMs = refreshBackoffMs === 0 ? TOKEN_RETRY_BASE_MS : Math.min(refreshBackoffMs * 2, TOKEN_RETRY_MAX_MS);
    return refreshBackoffMs;
  };

  /** Asks the host for a fresh token and hands it to the frame; a failure is reported and retried, backed off. */
  const requestToken = (): void => {
    const getToken = config.getToken;
    if (destroyed || refreshInFlight || !getToken) return;
    refreshInFlight = true;
    void getToken().then(
      (token) => {
        refreshInFlight = false;
        if (destroyed) return;
        post({ snapnedit: 1, type: 'refresh-token', payload: { token } });
      },
      (e: unknown) => {
        refreshInFlight = false;
        if (destroyed) return;
        emitLocal('error', { code: 'unauthorized', message: `getToken failed: ${String(e)}` });
        // One failed round-trip to the host's backend is not fatal — retry,
        // backed off, so a broken endpoint isn't hammered either.
        armRefreshTimer(nextBackoff(), requestToken);
      },
    );
  };

  /** Handles a `token-expiring` report; returns whether it should still reach host listeners. */
  const onTokenExpiring = (data: EmbedEvents['token-expiring']): boolean => {
    if (destroyed) return false;
    const expMs = Date.parse(data.expiresAt);
    const alreadyExpired = Number.isFinite(expMs) && expMs <= Date.now();
    if (!config.getToken) {
      // Nothing can refresh this session. Wait out whatever TTL is left, then
      // say so exactly once — otherwise the first sign of trouble is a silent
      // storm of 401s from calls the host thinks should work.
      if (tokenExpiredEmitted || refreshTimer !== null) return false;
      const delay = Number.isFinite(expMs) ? Math.max(0, expMs - Date.now()) : 0;
      armRefreshTimer(delay, () => {
        tokenExpiredEmitted = true; // one-shot: the ticker stops here
        emitLocal('error', { code: 'token_expired', message: 'the embed session token expired and no getToken was configured' });
      });
      return true;
    }
    if (!alreadyExpired) {
      // The frame warns at 80% of the TTL, so there is still a real window:
      // refresh immediately and treat the session as healthy again.
      refreshBackoffMs = 0;
      clearRefreshTimer();
      requestToken();
      return true;
    }
    if (refreshTimer !== null || refreshInFlight) return false; // already handling this episode; stay quiet
    const firstOfEpisode = refreshBackoffMs === 0;
    armRefreshTimer(nextBackoff(), requestToken);
    return firstOfEpisode;
  };

  const onMessage = (event: MessageEvent): void => {
    if (!isTrustedEvent(event, iframe.contentWindow, embedOrigin) || !isProtocolMessage(event.data)) return;
    const msg = event.data as FrameToHostMessage;
    if (msg.type === 'ready-for-init') {
      if (initSent) return;
      initSent = true;
      if (!config.token && !config.publishableKey && config.getToken) {
        // getToken-only bootstrap: fetch a token before the frame ever sees a config, so it never has to ask again.
        config.getToken()
          .then((token) => {
            if (destroyed) return;
            post({ snapnedit: 1, type: 'init', payload: { config: { ...stripFunctions(config), token } } });
          })
          .catch((e: unknown) => {
            if (destroyed) return;
            teardown();
            if (readyReject) { readyReject(new EmbedError('unauthorized', `getToken failed: ${String(e)}`)); readyResolve = null; readyReject = null; }
          });
        return;
      }
      post({ snapnedit: 1, type: 'init', payload: { config: stripFunctions(config) } });
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      win.clearTimeout(p.timer);
      if (msg.payload.ok) p.resolve(msg.payload.value);
      else p.reject(new EmbedError(msg.payload.error.code, msg.payload.error.message));
      return;
    }
    if (msg.type === 'event') {
      const { name, data } = msg.payload;
      if (name === 'ready') {
        readyPayload = data as EmbedEvents['ready'];
        if (readyResolve) {
          if (bootTimer !== null) { win.clearTimeout(bootTimer); bootTimer = null; }
          readyResolve(handle); readyResolve = null; readyReject = null;
        }
      }
      if (name === 'error' && readyReject) {
        if (bootTimer !== null) { win.clearTimeout(bootTimer); bootTimer = null; }
        const err = data as EmbedEvents['error'];
        teardown();
        readyReject(new EmbedError(err.code, err.message)); readyResolve = null; readyReject = null;
      }
      if (name === 'token-expiring' && !onTokenExpiring(data as EmbedEvents['token-expiring'])) return;
      emitLocal(name, data as never);
    }
  };
  win.addEventListener('message', onMessage);

  const call = (method: EditorMethod, args: unknown[]): Promise<unknown> => {
    if (destroyed) return Promise.reject(new EmbedError('destroyed', 'editor was destroyed'));
    const id = newRequestId();
    return new Promise((resolve, reject) => {
      const timer = win.setTimeout(() => {
        pending.delete(id);
        reject(new EmbedError('timeout', `${method} timed out`));
      }, LONG_CALLS.has(method) ? LONG_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      post({ snapnedit: 1, type: 'call', id, payload: { method, args } });
    });
  };

  const handle = {
    iframe,
    on(event, cb) {
      const set = listeners.get(event) ?? new Set();
      set.add(cb as (p: never) => void);
      listeners.set(event, set);
      // `ready` already fired for anyone who registered after awaiting
      // `mount()` — replay it so the listener isn't silently dead. See
      // `readyPayload`. Asynchronously, so `on()` behaves identically whether
      // it beat the frame or not: it always returns its unsubscribe function
      // before the listener runs, and a throwing listener can never propagate
      // out of `on()` itself.
      if (event === 'ready' && readyPayload !== null) {
        const payload = readyPayload;
        queueMicrotask(() => {
          if (destroyed) return;
          if (listeners.get('ready')?.has(cb as (p: never) => void) !== true) return; // unsubscribed in between
          invokeListener('ready', cb as (p: EmbedEvents['ready']) => void, payload);
        });
      }
      return () => handle.off(event, cb);
    },
    off(event, cb) { listeners.get(event)?.delete(cb as (p: never) => void); },
    destroy() { teardown(); },
  } as EditorHandle;
  for (const method of METHODS) {
    (handle as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => call(method, args);
  }

  return new Promise<EditorHandle>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    bootTimer = win.setTimeout(() => {
      bootTimer = null;
      if (readyReject) {
        teardown();
        readyReject(new EmbedError('timeout', 'editor did not become ready within 60s'));
        readyResolve = null; readyReject = null;
      }
    }, 60_000);
  });
}
