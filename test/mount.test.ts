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

/** Mounts and drives the handshake to `ready`, the starting point most tests need. */
async function booted(env: ReturnType<typeof fakeEnv>, config: Parameters<typeof mount>[1]) {
  const p = mount(env.target as never, config, { window: env.window as never, document: env.document as never });
  env.emit({ snapnedit: 1, type: 'ready-for-init' });
  env.emit({ snapnedit: 1, type: 'event', payload: { name: 'ready', data: { version: '0.1.0' } } });
  return p;
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

  test('on("ready") registered AFTER ready fired replays the buffered payload, asynchronously', async () => {
    // The natural usage — `const h = await mount(...); h.on('ready', ...)` —
    // registers strictly after the frame's `ready` message. Without the replay
    // that listener could never fire.
    const env = fakeEnv();
    const handle = await booted(env, { token: 't' });
    const late = vi.fn();
    handle.on('ready', late);
    // Never synchronously inside `on()`: the listener must not run before the
    // unsubscribe function is even in the caller's hands.
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(late).toHaveBeenCalledWith({ version: '0.1.0' });
    // Other events are live-only: a late listener for them is not back-filled.
    const change = vi.fn();
    handle.on('change', change);
    await Promise.resolve();
    expect(change).not.toHaveBeenCalled();
  });

  test('a ready listener that unsubscribes before the replay lands is not called', async () => {
    const env = fakeEnv();
    const handle = await booted(env, { token: 't' });
    const late = vi.fn();
    handle.on('ready', late)();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });

  test('a throwing ready listener is reported, never propagated out of on()', async () => {
    const env = fakeEnv();
    const handle = await booted(env, { token: 't' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => handle.on('ready', () => { throw new Error('boom'); })).not.toThrow();
    await Promise.resolve();
    expect(logged).toHaveBeenCalledWith('[snapnedit embed] ready listener threw', expect.any(Error));
    logged.mockRestore();
  });

  test('a throwing listener does not stop the other listeners for the same event', async () => {
    const env = fakeEnv();
    const handle = await booted(env, { token: 't' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    handle.on('change', () => { throw new Error('boom'); });
    handle.on('change', second);
    env.emit({ snapnedit: 1, type: 'event', payload: { name: 'change', data: { dirty: true, pageCount: 1 } } });
    expect(second).toHaveBeenCalledWith({ dirty: true, pageCount: 1 });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  test('destroy() drops the ready replay buffer', async () => {
    const env = fakeEnv();
    const handle = await booted(env, { token: 't' });
    handle.destroy();
    const late = vi.fn();
    handle.on('ready', late);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });

  test('an ALREADY-EXPIRED token reports token-expiring once, then retries on a 1s → 2s → 4s backoff', async () => {
    // The frame re-arms its expiry clock on a 1s floor, so a stale token makes
    // it report `token-expiring` every second. The loader must not turn that
    // into one `getToken` round-trip (and one host event) per second.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const env = fakeEnv();
      const getToken = vi.fn(async () => 'still-stale');
      const handle = await booted(env, { token: 'old', getToken });
      const onExpiring = vi.fn();
      handle.on('token-expiring', onExpiring);
      const expiring = (expiresAt: string) => env.emit({ snapnedit: 1, type: 'event', payload: { name: 'token-expiring', data: { expiresAt } } });
      const stale = '2025-12-31T23:59:59.000Z';

      expiring(stale);
      expect(onExpiring).toHaveBeenCalledTimes(1);
      expect(getToken).not.toHaveBeenCalled();
      // The frame keeps reporting while we wait: no extra event, no extra call.
      await vi.advanceTimersByTimeAsync(999);
      expiring(stale);
      expect(onExpiring).toHaveBeenCalledTimes(1);
      expect(getToken).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // t=1s — first retry
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(env.posted.at(-1)?.msg).toEqual({ snapnedit: 1, type: 'refresh-token', payload: { token: 'still-stale' } });

      expiring(stale); // the fresh token was stale too
      await vi.advanceTimersByTimeAsync(1_999);
      expect(getToken).toHaveBeenCalledTimes(1); // still waiting out the 2s step
      await vi.advanceTimersByTimeAsync(1);
      expect(getToken).toHaveBeenCalledTimes(2);

      expiring(stale);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(getToken).toHaveBeenCalledTimes(2); // 4s step
      await vi.advanceTimersByTimeAsync(1);
      expect(getToken).toHaveBeenCalledTimes(3);
      expect(onExpiring).toHaveBeenCalledTimes(1);

      // A healthy warning (the frame fires at 80% of the TTL, so `expiresAt` is
      // still in the future) refreshes immediately and resets the backoff.
      expiring(new Date(Date.now() + 60_000).toISOString());
      expect(onExpiring).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(getToken).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the backoff is capped at 30s', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const env = fakeEnv();
      const getToken = vi.fn(async () => 'still-stale');
      const handle = await booted(env, { token: 'old', getToken });
      const stale = '2025-12-31T23:59:59.000Z';
      const expiring = () => env.emit({ snapnedit: 1, type: 'event', payload: { name: 'token-expiring', data: { expiresAt: stale } } });
      for (const step of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        expiring();
        await vi.advanceTimersByTimeAsync(step - 1);
        const before = getToken.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1);
        expect(getToken.mock.calls.length).toBe(before + 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('a rejecting getToken reports the failure and retries with backoff instead of giving up', async () => {
    vi.useFakeTimers();
    try {
      const env = fakeEnv();
      const getToken = vi.fn(async () => { throw new Error('backend down'); });
      const handle = await booted(env, { token: 'old', getToken });
      const onError = vi.fn();
      handle.on('error', onError);
      env.emit({ snapnedit: 1, type: 'event', payload: { name: 'token-expiring', data: { expiresAt: 'not-a-date' } } });
      await vi.advanceTimersByTimeAsync(0);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith({ code: 'unauthorized', message: expect.stringContaining('getToken failed') as unknown as string });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getToken).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getToken).toHaveBeenCalledTimes(3);
      // destroy() must stop the retry loop dead.
      handle.destroy();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getToken).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('without getToken, expiry surfaces error(token_expired) exactly once and stops the ticker', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const env = fakeEnv();
      const handle = await booted(env, { token: 'old' });
      const onError = vi.fn();
      const onExpiring = vi.fn();
      handle.on('error', onError);
      handle.on('token-expiring', onExpiring);
      const expiresAt = new Date(Date.now() + 5_000).toISOString();
      const expiring = () => env.emit({ snapnedit: 1, type: 'event', payload: { name: 'token-expiring', data: { expiresAt } } });

      expiring();
      expect(onExpiring).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expiring(); // the frame keeps warning; the host hears it once
      expect(onExpiring).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledWith({ code: 'token_expired', message: expect.any(String) as unknown as string });
      expiring();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('teardown() clears the 60s boot timer (a rejecting getToken must not leave it armed)', async () => {
    // `teardown()` is reached before `ready` on the getToken-rejection path,
    // which is the one route that did NOT clear `bootTimer` itself — leaving a
    // 60s timer holding the event loop open against a removed iframe.
    vi.useFakeTimers();
    try {
      const env = fakeEnv();
      const p = mount(env.target as never, { getToken: async () => { throw new Error('nope'); } }, { window: env.window as never, document: env.document as never });
      env.emit({ snapnedit: 1, type: 'ready-for-init' });
      await expect(p).rejects.toMatchObject({ code: 'unauthorized' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('rejects when neither publishableKey nor token is given', async () => {
    const env = fakeEnv();
    await expect(mount(env.target as never, {}, { window: env.window as never, document: env.document as never })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
