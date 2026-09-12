import { describe, expect, test, vi } from 'vitest';
import {
  ERROR_EVENT,
  installLoader,
  markLoaderScript,
  parseScriptConfig,
  PROCESSED_ATTR,
  READY_EVENT,
  resolveLoaderScript,
  type InstallLoaderDeps,
  type LoaderHostDocument,
} from '../src/loader.js';
import type { EditorHandle, EmbedConfig, EmbedEventName, EmbedEvents } from '../src/types.js';

const SELECTOR = `script[data-key][src*="/embed/v1.js"]:not([${PROCESSED_ATTR}]), script[data-token][src*="/embed/v1.js"]:not([${PROCESSED_ATTR}])`;

describe('parseScriptConfig', () => {
  test('reads data-key, data-target, data-config JSON and derives origin from src', () => {
    const el = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_x', target: '#editor', config: '{"theme":{"accent":"#f00"}}' } as DOMStringMap };
    expect(parseScriptConfig(el)).toEqual({ target: '#editor', config: { publishableKey: 'pk_live_x', origin: 'https://snapnedit.com', theme: { accent: '#f00' } } });
  });
  test('data-token wins over nothing; invalid data-config is ignored', () => {
    const el = { src: 'http://localhost:3000/embed/v1.js', dataset: { token: 't', config: '{oops' } as DOMStringMap };
    expect(parseScriptConfig(el)).toEqual({ target: null, config: { token: 't', origin: 'http://localhost:3000' } });
  });
});

describe('resolveLoaderScript', () => {
  /** Minimal `document` stand-in: a fixed `currentScript` plus a canned answer for the loader selector. */
  function doc(currentScript: unknown, matches: unknown[] = []) {
    return {
      currentScript: currentScript as Element | null,
      querySelectorAll: (selector: string) => {
        // The real DOM would filter; asserting the selector here is what pins
        // the contract (data-key OR data-token, on OUR script src, not already
        // mounted from).
        expect(selector).toBe(SELECTOR);
        return matches as ArrayLike<Element>;
      },
    };
  }

  test('uses document.currentScript when the loader runs synchronously from its own tag', () => {
    const current = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_x' } };
    const other = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_other' } };
    expect(resolveLoaderScript(doc(current, [other]))).toBe(current);
  });

  test('falls back to the FIRST UNPROCESSED matching tag when currentScript is null (defer/async/module)', () => {
    const first = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_1' } };
    const last = { src: 'https://snapnedit.com/embed/v1.js', dataset: { token: 't2' } };
    // Two tags, two executions, `currentScript` null in both: each execution
    // must claim a DIFFERENT tag (the old "last match wins" mounted `last`
    // twice and never mounted `first`).
    const one = resolveLoaderScript(doc(null, [first, last]));
    expect(one).toBe(first);
    markLoaderScript(one as never);
    expect(resolveLoaderScript(doc(null, [first, last]))).toBe(last);
  });

  test('a currentScript that already auto-mounted is not resolved a second time', () => {
    const current = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_x' } };
    markLoaderScript(current as never);
    expect(resolveLoaderScript(doc(current, []))).toBeNull();
  });

  test('returns null when currentScript is null and nothing matches', () => {
    expect(resolveLoaderScript(doc(null, []))).toBeNull();
  });
});

// --- installLoader ---------------------------------------------------------

type Listeners = Partial<Record<EmbedEventName, (payload: never) => void>>;

/** A `mount()` stand-in whose handle records `on()` subscriptions so a test can fire an event at the loader. */
function fakeHandle(): { handle: EditorHandle; listeners: Listeners } {
  const listeners: Listeners = {};
  const handle = {
    on(event: EmbedEventName, cb: (payload: never) => void) {
      listeners[event] = cb;
      return () => { delete listeners[event]; };
    },
    destroy() {},
  } as unknown as EditorHandle;
  return { handle, listeners };
}

function fakeScript(dataset: Record<string, string>) {
  return { src: 'https://snapnedit.com/embed/v1.js', dataset: { ...dataset } as DOMStringMap, insertAdjacentElement: vi.fn() };
}

function fakeContainer() {
  const events: CustomEvent[] = [];
  return {
    events,
    style: { cssText: '' },
    dispatchEvent: (e: Event) => { events.push(e as CustomEvent); return true; },
  };
}

function loaderEnv(scripts: ReturnType<typeof fakeScript>[], opts: { currentScript?: unknown; target?: unknown } = {}) {
  const created: ReturnType<typeof fakeContainer>[] = [];
  const document = {
    currentScript: (opts.currentScript ?? null) as Element | null,
    querySelectorAll: () => scripts as unknown as ArrayLike<Element>,
    querySelector: () => (opts.target ?? null) as Element | null,
    createElement: () => { const c = fakeContainer(); created.push(c); return c as unknown as HTMLElement; },
  } satisfies LoaderHostDocument;
  const mounted: { target: unknown; config: EmbedConfig }[] = [];
  const handles: ReturnType<typeof fakeHandle>[] = [];
  const mount = vi.fn(async (target: HTMLElement, config: EmbedConfig) => {
    mounted.push({ target, config });
    const h = fakeHandle();
    handles.push(h);
    return h.handle;
  });
  const window: { Snapnedit?: unknown } = {};
  const deps: InstallLoaderDeps = { window: window as never, document, mount };
  return { deps, window, document, mounted, handles, created };
}

describe('installLoader', () => {
  test('exposes window.Snapnedit and auto-mounts the tag once, marking it processed', async () => {
    const script = fakeScript({ key: 'pk_live_x' });
    const env = loaderEnv([script]);
    installLoader(env.deps);
    await vi.waitFor(() => expect(env.mounted).toHaveLength(1));
    expect(env.window.Snapnedit).toMatchObject({ version: expect.any(String) as unknown as string });
    expect(env.mounted[0]?.config).toEqual({ publishableKey: 'pk_live_x', origin: 'https://snapnedit.com' });
    expect(script.dataset.snapneditMounted).toBe('');
    // Same tag, second execution of the loader: nothing left to mount.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installLoader(env.deps);
    expect(env.mounted).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  test('two loader tags with a null currentScript auto-mount exactly once each, in document order', async () => {
    const first = fakeScript({ key: 'pk_live_1' });
    const second = fakeScript({ token: 't2' });
    const env = loaderEnv([first, second]);
    installLoader(env.deps);
    installLoader(env.deps);
    await vi.waitFor(() => expect(env.mounted).toHaveLength(2));
    expect(env.mounted[0]?.config.publishableKey).toBe('pk_live_1');
    expect(env.mounted[1]?.config.token).toBe('t2');
    expect(env.mounted[0]?.target).not.toBe(env.mounted[1]?.target);
    expect(first.dataset.snapneditMounted).toBe('');
    expect(second.dataset.snapneditMounted).toBe('');
  });

  test('a tag without credentials mounts nothing and stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const script = fakeScript({});
    const env = loaderEnv([script], { currentScript: script });
    installLoader(env.deps);
    expect(env.mounted).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('post-ready errors reach the container as console.error + a bubbling snapnedit:error CustomEvent', async () => {
    const script = fakeScript({ token: 't' });
    const env = loaderEnv([script]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installLoader(env.deps);
    await vi.waitFor(() => expect(env.handles).toHaveLength(1));
    const container = env.created[0]!;
    const listeners = env.handles[0]!.listeners;

    (listeners.ready as (p: EmbedEvents['ready']) => void)({ version: '0.1.0' });
    const ready = container.events.find((e) => e.type === READY_EVENT);
    expect(ready?.bubbles).toBe(true);
    expect(ready?.detail).toMatchObject({ version: '0.1.0', editor: env.handles[0]!.handle });

    (listeners.error as (p: EmbedEvents['error']) => void)({ code: 'token_expired', message: 'gone' });
    const failed = container.events.find((e) => e.type === ERROR_EVENT);
    expect(failed?.bubbles).toBe(true);
    expect(failed?.detail).toEqual({ code: 'token_expired', message: 'gone' });
    expect(error).toHaveBeenCalledWith('[snapnedit embed] token_expired: gone');
    error.mockRestore();
  });

  test('a failed mount() also surfaces as console.error + snapnedit:error, carrying the EmbedError code', async () => {
    const script = fakeScript({ key: 'pk_live_x' });
    const env = loaderEnv([script]);
    env.deps.mount = async () => { throw Object.assign(new Error('nope'), { code: 'origin_denied' }); };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    installLoader(env.deps);
    await vi.waitFor(() => expect(env.created[0]?.events).toHaveLength(1));
    expect(env.created[0]?.events[0]?.detail).toEqual({ code: 'origin_denied', message: 'nope' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  test('mounts into data-target when it resolves, instead of injecting a container', async () => {
    const script = fakeScript({ key: 'pk_live_x', target: '#editor' });
    const target = fakeContainer();
    const env = loaderEnv([script], { target });
    installLoader(env.deps);
    await vi.waitFor(() => expect(env.mounted).toHaveLength(1));
    expect(env.mounted[0]?.target).toBe(target);
    expect(env.created).toHaveLength(0);
    expect(script.insertAdjacentElement).not.toHaveBeenCalled();
  });
});
