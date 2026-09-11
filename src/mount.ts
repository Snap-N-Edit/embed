import { DEFAULT_EMBED_ORIGIN, embedFrameUrl, isProtocolMessage, isTrustedEvent, newRequestId, stripFunctions, type FrameToHostMessage, type HostToFrameMessage } from './protocol.js';
import { EmbedError, type EditorHandle, type EditorMethod, type EmbedConfig, type EmbedEventName, type EmbedEvents } from './types.js';

export const CALL_TIMEOUT_MS = 30_000;
export const LONG_CALL_TIMEOUT_MS = 180_000;
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
  let readyResolve: ((h: EditorHandle) => void) | null = null;
  let readyReject: ((e: EmbedError) => void) | null = null;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;

  const post = (msg: HostToFrameMessage): void => {
    iframe.contentWindow?.postMessage(msg, embedOrigin);
  };

  const emitLocal = <E extends EmbedEventName>(name: E, data: EmbedEvents[E]): void => {
    for (const cb of listeners.get(name) ?? []) (cb as (p: EmbedEvents[E]) => void)(data);
  };

  const onMessage = (event: MessageEvent): void => {
    if (!isTrustedEvent(event, iframe.contentWindow, embedOrigin) || !isProtocolMessage(event.data)) return;
    const msg = event.data as FrameToHostMessage;
    if (msg.type === 'ready-for-init') {
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
      if (name === 'ready' && readyResolve) {
        if (bootTimer !== null) { win.clearTimeout(bootTimer); bootTimer = null; }
        readyResolve(handle); readyResolve = null; readyReject = null;
      }
      if (name === 'error' && readyReject) {
        if (bootTimer !== null) { win.clearTimeout(bootTimer); bootTimer = null; }
        const err = data as EmbedEvents['error'];
        readyReject(new EmbedError(err.code, err.message)); readyResolve = null; readyReject = null;
      }
      if (name === 'token-expiring' && config.getToken) {
        void config.getToken().then((token) => post({ snapnedit: 1, type: 'refresh-token', payload: { token } }))
          .catch((e: unknown) => emitLocal('error', { code: 'unauthorized', message: `getToken failed: ${String(e)}` }));
      }
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
      return () => handle.off(event, cb);
    },
    off(event, cb) { listeners.get(event)?.delete(cb as (p: never) => void); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener('message', onMessage);
      for (const p of pending.values()) { win.clearTimeout(p.timer); p.reject(new EmbedError('destroyed', 'editor was destroyed')); }
      pending.clear();
      iframe.remove();
    },
  } as EditorHandle;
  for (const method of METHODS) {
    (handle as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => call(method, args);
  }

  return new Promise<EditorHandle>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    bootTimer = win.setTimeout(() => {
      bootTimer = null;
      if (readyReject) { readyReject(new EmbedError('timeout', 'editor did not become ready within 60s')); readyResolve = null; readyReject = null; }
    }, 60_000);
  });
}
