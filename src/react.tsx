import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from 'react';
import { mount } from './mount.js';
import type { EditorHandle, EmbedConfig, EmbedEvents } from './types.js';

export interface SnapneditEditorProps {
  config: EmbedConfig;
  className?: string;
  style?: CSSProperties;
  onReady?: (handle: EditorHandle) => void;
  onChange?: (e: EmbedEvents['change']) => void;
  onExport?: (e: EmbedEvents['export']) => void;
  onSave?: (e: EmbedEvents['save']) => void;
  onJob?: (e: EmbedEvents['job']) => void;
  onError?: (e: EmbedEvents['error']) => void;
  onClose?: () => void;
}

/** React wrapper over `mount()`. Passing `onSave`/`onClose` turns on the frame's Save/Close buttons unless `config.features` says otherwise. */
export const SnapneditEditor = forwardRef<EditorHandle | null, SnapneditEditorProps>(function SnapneditEditor(props, ref) {
  const container = useRef<HTMLDivElement | null>(null);
  // The handle lives in state (not a plain ref) so `ref.current`/renders
  // actually observe it once `mount()` resolves — a ref written inside a
  // passive effect's `.then()` is invisible to `useImperativeHandle`'s
  // layout-effect `create()`, which already ran (with `handleRef.current`
  // still null) by the time the promise settles.
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  useImperativeHandle<EditorHandle | null, EditorHandle | null>(ref, () => handle, [handle]);
  const { config, onReady, onChange, onExport, onSave, onJob, onError, onClose } = props;

  // Latest-callback ref: assigned every render (not inside an effect) so the
  // event subscriptions below — created once per mount effect run — always
  // invoke whatever callback the host most recently passed, instead of the
  // closure captured when the frame first became ready.
  const callbacks = useRef({ onReady, onChange, onExport, onSave, onJob, onError, onClose });
  callbacks.current = { onReady, onChange, onExport, onSave, onJob, onError, onClose };

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    let resolvedHandle: EditorHandle | null = null;
    const unsubscribers: Array<() => void> = [];
    const features = { ...(config.features ?? {}) };
    // save/close defaults are decided from whether onSave/onClose were passed
    // AT MOUNT TIME (i.e. when this effect last ran, which is whenever the
    // auth/origin deps below change) — toggling the callbacks later without
    // touching publishableKey/token/origin does not retoggle the frame's
    // Save/Close buttons; use config.features explicitly for that.
    if (onSave && features.save === undefined) features.save = true;
    if (onClose && features.close === undefined) features.close = true;
    mount(container.current, { ...config, features })
      .then((h) => {
        if (cancelled) { h.destroy(); return; }
        resolvedHandle = h;
        unsubscribers.push(
          h.on('change', (e) => callbacks.current.onChange?.(e)),
          h.on('export', (e) => callbacks.current.onExport?.(e)),
          h.on('save', (e) => callbacks.current.onSave?.(e)),
          h.on('job', (e) => callbacks.current.onJob?.(e)),
          h.on('error', (e) => callbacks.current.onError?.(e)),
          h.on('close', () => callbacks.current.onClose?.()),
        );
        setHandle(h);
        callbacks.current.onReady?.(h);
      })
      .catch((err: unknown) => callbacks.current.onError?.({ code: 'internal', message: String(err) }));
    return () => {
      cancelled = true;
      for (const off of unsubscribers) off();
      resolvedHandle?.destroy();
      setHandle(null);
    };
    // The editor is (re)mounted only when the auth/origin inputs change; theme/features go through setTheme/setFeatures.
  }, [config.publishableKey, config.token, config.origin]);

  useEffect(() => { if (config.theme) void handle?.setTheme(config.theme).catch(() => {}); }, [handle, config.theme]);
  useEffect(() => { if (config.features) void handle?.setFeatures(config.features).catch(() => {}); }, [handle, config.features]);

  return <div ref={container} className={props.className} style={{ width: '100%', height: 640, ...props.style }} />;
});
