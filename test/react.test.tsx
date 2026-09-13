// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EditorHandle, EmbedConfig, EmbedEventName, EmbedEvents } from '../src/types.js';

/** Listeners the fake handle collected, so a test can push an event at the wrapper. */
type Listeners = Map<EmbedEventName, Set<(payload: never) => void>>;

const state = vi.hoisted(() => ({
  /** Resolves/rejects the pending `mount()`; set per test. */
  mount: vi.fn(),
}));
vi.mock('../src/mount.js', () => ({ mount: state.mount }));

const { SnapneditEditor } = await import('../src/react.js');

function fakeHandle() {
  const listeners: Listeners = new Map();
  const destroy = vi.fn();
  const handle = {
    iframe: {} as HTMLIFrameElement,
    destroy,
    on(event: EmbedEventName, cb: (payload: never) => void) {
      const set = listeners.get(event) ?? new Set<(payload: never) => void>();
      set.add(cb);
      listeners.set(event, set);
      return () => { set.delete(cb); };
    },
    off(event: EmbedEventName, cb: (payload: never) => void) { listeners.get(event)?.delete(cb); },
    setTheme: vi.fn(async () => {}),
    setFeatures: vi.fn(async () => {}),
  } as unknown as EditorHandle;
  const emit = <E extends EmbedEventName>(event: E, payload: EmbedEvents[E]): void => {
    for (const cb of listeners.get(event) ?? []) (cb as (p: EmbedEvents[E]) => void)(payload);
  };
  return { handle, destroy, emit, listeners };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  state.mount.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const config: EmbedConfig = { publishableKey: 'pk_live_x' };

describe('<SnapneditEditor>', () => {
  test('mounts into its own div, populates the ref and calls onReady with the handle', async () => {
    const fake = fakeHandle();
    state.mount.mockResolvedValue(fake.handle);
    const ref = createRef<EditorHandle | null>();
    const onReady = vi.fn();

    await act(async () => { root.render(<SnapneditEditor ref={ref} config={config} onReady={onReady} />); });

    const div = container.firstElementChild as HTMLDivElement;
    expect(div.tagName).toBe('DIV');
    expect(div.style.width).toBe('100%');
    expect(state.mount).toHaveBeenCalledTimes(1);
    expect(state.mount.mock.calls[0]?.[0]).toBe(div);
    expect(ref.current).toBe(fake.handle);
    expect(onReady).toHaveBeenCalledWith(fake.handle);
  });

  test('forwards frame events to the matching props', async () => {
    const fake = fakeHandle();
    state.mount.mockResolvedValue(fake.handle);
    const onChange = vi.fn();
    const onJob = vi.fn();
    const onSave = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(<SnapneditEditor config={config} onChange={onChange} onJob={onJob} onSave={onSave} onError={onError} onClose={onClose} />);
    });

    act(() => { fake.emit('change', { dirty: true, pageCount: 2 }); });
    act(() => { fake.emit('job', { operation: 'upscale', status: 'succeeded', credits: 1, cached: false, deliveryOnly: false }); });
    act(() => { fake.emit('error', { code: 'token_expired', message: 'gone' }); });
    act(() => { fake.emit('close', {}); });
    expect(onChange).toHaveBeenCalledWith({ dirty: true, pageCount: 2 });
    expect(onJob).toHaveBeenCalledWith({ operation: 'upscale', status: 'succeeded', credits: 1, cached: false, deliveryOnly: false });
    expect(onError).toHaveBeenCalledWith({ code: 'token_expired', message: 'gone' });
    expect(onClose).toHaveBeenCalledWith();
    expect(onSave).not.toHaveBeenCalled();
    // onSave/onClose passed ⇒ the Save/Close buttons are switched on for the frame.
    expect((state.mount.mock.calls[0]?.[1] as EmbedConfig).features).toMatchObject({ save: true, close: true });
  });

  test('a changed callback prop is honored WITHOUT remounting the editor', async () => {
    const fake = fakeHandle();
    state.mount.mockResolvedValue(fake.handle);
    const first = vi.fn();
    const second = vi.fn();
    const blob = new Blob(['x']);

    await act(async () => { root.render(<SnapneditEditor config={config} onExport={first} />); });
    await act(async () => { root.render(<SnapneditEditor config={config} onExport={second} />); });

    act(() => { fake.emit('export', { format: 'png', blob, width: 1, height: 1 }); });
    expect(state.mount).toHaveBeenCalledTimes(1); // same auth inputs ⇒ no remount
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ format: 'png', blob, width: 1, height: 1 });
  });

  test('unmounting destroys the handle and drops the subscriptions', async () => {
    const fake = fakeHandle();
    state.mount.mockResolvedValue(fake.handle);
    const onChange = vi.fn();
    await act(async () => { root.render(<SnapneditEditor config={config} onChange={onChange} />); });

    await act(async () => { root.render(<></>); });
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    act(() => { fake.emit('change', { dirty: true, pageCount: 1 }); });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('a rejected mount() is reported through onError', async () => {
    state.mount.mockRejectedValue(new Error('origin denied'));
    const onError = vi.fn();
    await act(async () => { root.render(<SnapneditEditor config={config} onError={onError} />); });
    expect(onError).toHaveBeenCalledWith({ code: 'internal', message: expect.stringContaining('origin denied') as unknown as string });
  });

  test('changing the auth inputs remounts: the old handle is destroyed and mount() runs again', async () => {
    const first = fakeHandle();
    const second = fakeHandle();
    state.mount.mockResolvedValueOnce(first.handle).mockResolvedValueOnce(second.handle);
    const ref = createRef<EditorHandle | null>();

    await act(async () => { root.render(<SnapneditEditor ref={ref} config={{ publishableKey: 'pk_a' }} />); });
    await act(async () => { root.render(<SnapneditEditor ref={ref} config={{ publishableKey: 'pk_b' }} />); });

    expect(state.mount).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(second.handle);
  });
});
