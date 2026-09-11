import { describe, expect, test, vi } from 'vitest';
import { mount } from '../src/mount.js';
import type { HostToFrameMessage } from '../src/protocol.js';

/** Minimal fake: an iframe whose contentWindow records posted messages; a host window that can dispatch `message` events. */
function fakeEnv(embedOrigin = 'https://snapnedit.com', hostOrigin = 'http://host.test') {
  const posted: { msg: HostToFrameMessage; origin: string }[] = [];
  const frameWindow = { postMessage: (msg: HostToFrameMessage, origin: string) => posted.push({ msg, origin }) };
  const listeners = new Set<(e: MessageEvent) => void>();
  const iframe = {
    contentWindow: frameWindow, src: '', style: {} as Record<string, string>, remove: vi.fn(),
    setAttribute: vi.fn(), addEventListener: vi.fn(),
  };
  const target = { appendChild: vi.fn(), innerHTML: '' };
  const document = { createElement: () => iframe, querySelector: () => target };
  const window = {
    location: { origin: hostOrigin },
    addEventListener: (_: 'message', cb: (e: MessageEvent) => void) => listeners.add(cb),
    removeEventListener: (_: 'message', cb: (e: MessageEvent) => void) => listeners.delete(cb),
    setTimeout, clearTimeout,
  };
  const emit = (data: unknown, origin = embedOrigin, source: unknown = frameWindow) => {
    for (const cb of listeners) cb({ data, origin, source } as MessageEvent);
  };
  return { posted, iframe, target, document, window, emit, frameWindow };
}

describe('mount', () => {
  test('creates the iframe at /embed?host=<origin>, answers ready-for-init with init (getToken stripped), resolves on ready', async () => {
    const env = fakeEnv();
    const p = mount(env.target as never, { publishableKey: 'pk', getToken: async () => 'x' }, { window: env.window as never, document: env.document as never });
    expect(env.iframe.src).toBe('https://snapnedit.com/embed?host=http%3A%2F%2Fhost.test');
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    expect(env.posted[0]?.msg).toEqual({ snapnedit: 1, type: 'init', payload: { config: { publishableKey: 'pk' } } });
    expect(env.posted[0]?.origin).toBe('https://snapnedit.com');
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'ready', data: { version: '0.1.0' } } });
    const handle = await p;
    expect(handle.iframe).toBe(env.iframe);
  });

  test('ignores messages from the wrong origin or source', async () => {
    const env = fakeEnv();
    const p = mount(env.target as never, { token: 't' }, { window: env.window as never, document: env.document as never });
    env.emit({ snapnedit: 1, type: 'ready-for-init' }, 'https://evil.test');
    env.emit({ snapnedit: 1, type: 'ready-for-init' }, 'https://snapnedit.com', {});
    expect(env.posted).toHaveLength(0);
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'ready', data: { version: '0.1.0' } } });
    await p;
  });

  test('calls are correlated by id and resolve/reject from result messages', async () => {
    const env = fakeEnv();
    const p = mount(env.target as never, { token: 't' }, { window: env.window as never, document: env.document as never });
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'ready', data: { version: '0.1.0' } } });
    const handle = await p;
    const call = handle.getState();
    const sent = env.posted[1]!.msg as Extract<HostToFrameMessage, { type: 'call' }>;
    expect(sent.payload).toEqual({ method: 'getState', args: [] });
    env.emit({ snapnedit: 1, type: 'result', id: sent.id, payload: { ok: true, value: { canUndo: false } } });
    await expect(call).resolves.toEqual({ canUndo: false });
    const failing = handle.undo();
    const sent2 = env.posted[2]!.msg as Extract<HostToFrameMessage, { type: 'call' }>;
    env.emit({ snapnedit: 1, type: 'result', id: sent2.id, payload: { ok: false, error: { code: 'not_ready', message: 'nope' } } });
    await expect(failing).rejects.toMatchObject({ code: 'not_ready', message: 'nope' });
  });

  test('events reach on() listeners; token-expiring triggers getToken -> refresh-token; destroy removes the iframe and rejects later calls', async () => {
    const env = fakeEnv();
    const getToken = vi.fn(async () => 'fresh');
    const p = mount(env.target as never, { token: 'old', getToken }, { window: env.window as never, document: env.document as never });
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'ready', data: { version: '0.1.0' } } });
    const handle = await p;
    const onJob = vi.fn();
    handle.on('job', onJob);
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'job', data: { operation: 'upscale', status: 'started', credits: 1 } } });
    expect(onJob).toHaveBeenCalledWith({ operation: 'upscale', status: 'started', credits: 1 });
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'token-expiring', data: { expiresAt: 'x' } } });
    await vi.waitFor(() => expect(env.posted.at(-1)?.msg).toEqual({ snapnedit: 1, type: 'refresh-token', payload: { token: 'fresh' } }));
    handle.destroy();
    expect(env.iframe.remove).toHaveBeenCalled();
    await expect(handle.undo()).rejects.toMatchObject({ code: 'destroyed' });
  });

  test('boot timeout tears down (removes the message listener and the iframe) and a later ready-for-init posts nothing', async () => {
    vi.useFakeTimers();
    try {
      const env = fakeEnv();
      const p = mount(env.target as never, { token: 't' }, { window: env.window as never, document: env.document as never });
      const rejection = expect(p).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      expect(env.iframe.remove).toHaveBeenCalled();
      env.emit({ snapnedit: 1, type: 'ready-for-init' });
      expect(env.posted).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a pre-ready error event tears down (removes the iframe) and rejects mount with that error', async () => {
    const env = fakeEnv();
    const p = mount(env.target as never, { token: 't' }, { window: env.window as never, document: env.document as never });
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'error', data: { code: 'origin_denied', message: 'nope' } } });
    await expect(p).rejects.toMatchObject({ code: 'origin_denied', message: 'nope' });
    expect(env.iframe.remove).toHaveBeenCalled();
  });

  test('a second ready-for-init does not post a second init', async () => {
    const env = fakeEnv();
    const p = mount(env.target as never, { token: 't' }, { window: env.window as never, document: env.document as never });
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    expect(env.posted.filter((m) => m.msg.type === 'init')).toHaveLength(1);
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'ready', data: { version: '0.1.0' } } });
    await p;
  });

  test('getToken-only config: getToken is awaited before init, whose config carries the fresh token', async () => {
    const env = fakeEnv();
    const getToken = vi.fn(async () => 'fresh');
    const p = mount(env.target as never, { getToken }, { window: env.window as never, document: env.document as never });
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    await vi.waitFor(() => expect(env.posted).toHaveLength(1));
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(env.posted[0]?.msg).toEqual({ snapnedit: 1, type: 'init', payload: { config: { token: 'fresh' } } });
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'ready', data: { version: '0.1.0' } } });
    await p;
  });

  test('getToken-only config: a rejecting getToken tears down and rejects mount as unauthorized', async () => {
    const env = fakeEnv();
    const getToken = vi.fn(async () => { throw new Error('nope'); });
    const p = mount(env.target as never, { getToken }, { window: env.window as never, document: env.document as never });
    env.emit({ snapnedit: 1, type: 'ready-for-init' });
    await expect(p).rejects.toMatchObject({ code: 'unauthorized' });
    expect(env.iframe.remove).toHaveBeenCalled();
    expect(env.posted).toHaveLength(0);
  });

  test('rejects when neither publishableKey nor token is given', async () => {
    const env = fakeEnv();
    await expect(mount(env.target as never, {}, { window: env.window as never, document: env.document as never })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
