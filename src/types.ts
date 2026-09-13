import type { ErrorCode, OperationId } from '@snapnedit/shared';
import type { Document } from '@snapnedit/editor-core';

/**
 * Every format an `export` event can report.
 *
 * `'gif'` is the odd one out: the animated-GIF item appears only for a
 * document with animated layers and ignores the size chips, so it is NOT
 * something a host can put in `features.export.formats` (see
 * {@link AllowlistExportFormat}) — but it is a real format the editor
 * delivers, with an `image/gif` blob and the GIF's own dimensions.
 */
export type ExportFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'svg' | 'pdf' | 'gif';

/**
 * The subset of {@link ExportFormat} a host can REQUEST — both in
 * `features.export.formats` and as the argument to
 * {@link EditorHandle.export}. `'gif'` is excluded from both: the animated
 * GIF is produced only by the frame's own Export menu, for a document that
 * actually has animated layers, and is delivered through the `export` event.
 */
export type AllowlistExportFormat = Exclude<ExportFormat, 'gif'>;
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
  export?: { formats?: AllowlistExportFormat[]; mode?: 'download' | 'callback' | 'both' };
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
  /** An image to load at mount. A string is a URL and follows {@link EditorHandle.loadImage}'s rules exactly (absolute, cross-origin `https:`/`blob:`/`data:`). */
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

/** Options for {@link EditorHandle.export}. */
export interface EmbedExportOptions {
  /**
   * Pixel-dimension multiplier for the RASTER. The document is untouched:
   * `scale: 2` yields a `2·width × 2·height` bitmap of the same design.
   * Ignored by `svg` (resolution-independent); for `pdf` it raises the DPI of
   * the raster embedded in the page, not the page's own size.
   */
  scale?: number;
  /** Target raster width in px. Wins over {@link EmbedExportOptions.scale} when both are given. Same `svg`/`pdf` caveats. */
  targetWidth?: number;
  /** Lossy-encode quality, 0..1. Honored by `jpg`/`webp`/`avif`; ignored by `png`/`svg`/`pdf`. */
  quality?: number;
  /**
   * `pdf` ONLY: build one PDF containing EVERY page of the project (one PDF
   * page per project page, each sized to its own document), the same output
   * the frame's **PDF · all pages** menu item produces. Defaults to `false` —
   * a single PDF page for the ACTIVE document.
   *
   * Ignored (not rejected) for every other format: there is no multi-page
   * PNG/JPG/WebP/AVIF/SVG container. `width`/`height` in the
   * {@link ExportResult} report the ACTIVE page's dimensions, since pages may
   * differ in size.
   */
  allPages?: boolean;
}
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
   * A string `src` must be an ABSOLUTE `https:`, `blob:` or `data:` URL, and
   * an `https:` one must not be on the editor frame's own origin. Anything
   * else — a relative path, an `http:`/`file:`/app scheme, or
   * `https://snapnedit.com/...` — rejects with `invalid_input`. The frame
   * fetches URLs itself, with its own origin and credentials, and hands you
   * the exported bytes, so it will not be pointed at arbitrary schemes, nor
   * at its own origin, on a host's behalf. When the bytes live on your own
   * origin, fetch them host-side and pass the `Blob`/`File`.
   */
  loadImage(src: string | Blob | File, opts?: { name?: string }): Promise<void>;
  /** Adds `src` as a new layer, keeping the current document. Same `src` rules as {@link EditorHandle.loadImage}. */
  addImage(src: string | Blob | File, opts?: { name?: string }): Promise<void>;
  loadDocument(doc: Document): Promise<void>;
  getDocument(): Promise<Document>;
  getPages(): Promise<Document[]>;
  newDocument(width: number, height: number): Promise<void>;
  /**
   * Renders the document and resolves with the encoded bytes.
   *
   * Every format is produced by the same builder the frame's own Export menu
   * uses, so the bytes are what a download would have saved — `'pdf'` is a
   * real PDF whose single page is `doc.width × doc.height` (pass
   * {@link EmbedExportOptions.allPages} for one PDF of every project page),
   * and `'svg'` a true vector document. `width`/`height` report the
   * DOCUMENT's dimensions for `pdf`/`svg` and the rendered bitmap's (after
   * the pipeline's own clamping) for the raster formats.
   */
  export(format: AllowlistExportFormat, opts?: EmbedExportOptions): Promise<ExportResult>;
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
