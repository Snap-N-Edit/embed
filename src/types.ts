import type { ErrorCode, OperationId } from '@snapnedit/shared';
import type { Document } from '@snapnedit/editor-core';

export type ExportFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'svg' | 'pdf';
export type RailKey = 'templates' | 'text' | 'shapes' | 'elements' | 'data' | 'uploads' | 'stock' | 'draw' | 'brand' | 'magic' | 'saved';
export type PanelKey = 'layers' | 'adjustments' | 'filters' | 'effects' | 'animation' | 'ai';
export type ThemeColorKey = 'bg' | 'bg2' | 'surface' | 'surface2' | 'line' | 'line2' | 'text' | 'dim' | 'accent' | 'accentText' | 'checkerA' | 'checkerB';

export interface EmbedTheme {
  mode?: 'dark' | 'light';
  colors?: Partial<Record<ThemeColorKey, string>>;
  accent?: string;
  font?: string;
  radius?: number;
  css?: string;
}

export interface EmbedFeatures {
  tools?: RailKey[];
  aiOperations?: OperationId[];
  panels?: PanelKey[];
  collab?: boolean;
  stock?: boolean;
  branding?: boolean;
  export?: { formats?: ExportFormat[]; mode?: 'download' | 'callback' | 'both' };
  save?: boolean;
  close?: boolean;
}

export interface EmbedConfig {
  publishableKey?: string;
  token?: string;
  /** Loader-side only; never sent to the frame. Called when the frame reports `token-expiring`. */
  getToken?: () => Promise<string>;
  origin?: string;
  locale?: string;
  theme?: EmbedTheme;
  features?: EmbedFeatures;
  document?: Document;
  image?: string | Blob;
  canvas?: { width: number; height: number };
}

/** The config as it crosses postMessage: `getToken` removed. */
export type FrameConfig = Omit<EmbedConfig, 'getToken'>;

export type EmbedErrorCode = ErrorCode | 'not_ready' | 'mask_required' | 'timeout' | 'origin_denied' | 'destroyed' | 'token_expired';

export class EmbedError extends Error {
  constructor(readonly code: EmbedErrorCode, message: string) {
    super(message);
    this.name = 'EmbedError';
  }
}

export interface EmbedState {
  canUndo: boolean;
  canRedo: boolean;
  selection: string[];
  page: number;
  pageCount: number;
  width: number;
  height: number;
  dirty: boolean;
  busy: boolean;
}

export interface ExportResult { blob: Blob; width: number; height: number }
export type JobEventStatus = 'started' | 'succeeded' | 'failed';

export interface EmbedEvents {
  ready: { version: string };
  change: { dirty: boolean; pageCount: number };
  selection: { ids: string[]; kind: string | null };
  job: { operation: OperationId; status: JobEventStatus; jobId?: string; credits: number; durationMs?: number; error?: { code: EmbedErrorCode; message: string }; endUserId?: string };
  export: { format: ExportFormat; blob: Blob; width: number; height: number };
  save: { document: Document; pages: Document[] };
  close: Record<string, never>;
  /** Something failed outside a specific call. `token_expired`: the session token ran out and no `getToken` was configured to replace it. */
  error: { code: EmbedErrorCode; message: string };
  'token-expiring': { expiresAt: string };
}
export type EmbedEventName = keyof EmbedEvents;

export interface EditorHandle {
  /**
   * Replaces the document with one sized to `src`.
   *
   * A string `src` must be an `https:`, `blob:` or `data:` URL — anything
   * else (including a relative path, which would resolve against the FRAME's
   * origin rather than your page's) rejects with `invalid_input`. The frame
   * fetches URLs itself, with its own origin and credentials, so it will not
   * be pointed at arbitrary schemes on a host's behalf. When the bytes live
   * on your own origin, fetch them host-side and pass the `Blob`/`File`.
   */
  loadImage(src: string | Blob | File, opts?: { name?: string }): Promise<void>;
  /** Adds `src` as a new layer, keeping the current document. Same `src` rules as {@link EditorHandle.loadImage}. */
  addImage(src: string | Blob | File, opts?: { name?: string }): Promise<void>;
  loadDocument(doc: Document): Promise<void>;
  getDocument(): Promise<Document>;
  getPages(): Promise<Document[]>;
  newDocument(width: number, height: number): Promise<void>;
  export(format: ExportFormat, opts?: { scale?: number; targetWidth?: number; quality?: number }): Promise<ExportResult>;
  run(operation: OperationId, params?: Record<string, unknown>): Promise<void>;
  openTool(target: OperationId | RailKey): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  select(ids: string[]): Promise<void>;
  getState(): Promise<EmbedState>;
  setTheme(theme: EmbedTheme): Promise<void>;
  setFeatures(features: EmbedFeatures): Promise<void>;
  setLocale(locale: string): Promise<void>;
  on<E extends EmbedEventName>(event: E, cb: (payload: EmbedEvents[E]) => void): () => void;
  off<E extends EmbedEventName>(event: E, cb: (payload: EmbedEvents[E]) => void): void;
  destroy(): void;
  readonly iframe: HTMLIFrameElement;
}

/** Every `EditorHandle` method that is forwarded to the frame as a `call`. */
export type EditorMethod = Exclude<keyof EditorHandle, 'on' | 'off' | 'destroy' | 'iframe'>;
