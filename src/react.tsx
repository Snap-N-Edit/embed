import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from 'react';
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
  const handleRef = useRef<EditorHandle | null>(null);
  useImperativeHandle<EditorHandle | null, EditorHandle | null>(ref, () => handleRef.current, []);
  const { config, onReady, onChange, onExport, onSave, onJob, onError, onClose } = props;

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    const features = { ...(config.features ?? {}) };
    if (onSave && features.save === undefined) features.save = true;
    if (onClose && features.close === undefined) features.close = true;
    const p = mount(container.current, { ...config, features });
    p.then((handle) => {
      if (cancelled) { handle.destroy(); return; }
      handleRef.current = handle;
      if (onChange) handle.on('change', onChange);
      if (onExport) handle.on('export', onExport);
      if (onSave) handle.on('save', onSave);
      if (onJob) handle.on('job', onJob);
      if (onError) handle.on('error', onError);
      if (onClose) handle.on('close', onClose);
      onReady?.(handle);
    }).catch((err: unknown) => onError?.({ code: 'internal', message: String(err) }));
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
    // The editor is (re)mounted only when the auth/origin inputs change; theme/features go through setTheme/setFeatures.
  }, [config.publishableKey, config.token, config.origin]);

  useEffect(() => { if (config.theme) void handleRef.current?.setTheme(config.theme); }, [config.theme]);
  useEffect(() => { if (config.features) void handleRef.current?.setFeatures(config.features); }, [config.features]);

  return <div ref={container} className={props.className} style={{ width: '100%', height: 640, ...props.style }} />;
});
