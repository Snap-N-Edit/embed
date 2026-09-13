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

/**
 * The format union {@link EditorHandle.export} and
 * {@link EmbedExportTarget.format} accept — an alias of
 * {@link AllowlistExportFormat}, named after the calls that take it.
 */
export type EmbedExportFormat = AllowlistExportFormat;
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

/**
 * Every code an {@link EmbedError} can carry.
 *
 * Beyond the api's own {@link ErrorCode}s:
 *  - `not_ready` / `destroyed` / `timeout` — lifecycle failures of the call
 *    itself, not of anything the frame did.
 *  - `mask_required` — a mask-guided operation reached `run()`.
 *  - `origin_denied` / `token_expired` — the embed session was refused or ran out.
 *  - `network_error` — {@link EditorHandle.exportTo}'s upload `fetch` never
 *    produced a response: DNS/TLS failure, the bucket's CORS preflight
 *    refusing the frame's origin, or a redirect (uploads use
 *    `redirect: 'error'`). Nothing was uploaded, and the browser tells the
 *    page nothing more specific — check the frame's devtools console for the
 *    CORS message.
 *  - `upload_failed` — the bucket ANSWERED, with a non-2xx status. The status
 *    is in {@link EmbedError.details} as `{ status }` (403 for an expired or
 *    mis-signed presigned url, 400 when the `Content-Type` you signed does
 *    not match the format you exported).
 *  - `unsupported` — the editor frame does not implement the method you
 *    called: a NEWER loader talking to an OLDER `/embed`. Pin the loader to
 *    the frame's release, or wait out the deployment.
 */
export type EmbedErrorCode =
  | ErrorCode
  | 'not_ready'
  | 'mask_required'
  | 'timeout'
  | 'origin_denied'
  | 'destroyed'
  | 'token_expired'
  | 'network_error'
  | 'upload_failed'
  | 'unsupported';

export class EmbedError extends Error {
  /**
   * Structured context for the codes that have any — currently
   * `upload_failed`, which carries `{ status }`. Survives the postMessage
   * hop, so a host reading `err.details.status` sees the bucket's own status
   * code rather than having to parse the message.
   */
  readonly details?: Record<string, unknown>;

  constructor(readonly code: EmbedErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EmbedError';
    // Conditional so `exactOptionalPropertyTypes` holds: an error with no
    // details has no `details` KEY, rather than an explicit `undefined`.
    if (details !== undefined) this.details = details;
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

/**
 * Where {@link EditorHandle.exportTo} PUTs the rendered bytes: a presigned
 * upload url your own backend minted for your own bucket.
 *
 * The frame uploads straight from the iframe — your server never sees the
 * bytes, and the browser uploads once instead of handing them to your page to
 * re-send.
 */
export interface EmbedExportTarget {
  /**
   * The presigned upload url. Must be an ABSOLUTE `https:` url, and must not
   * be on the editor frame's own origin — the same rule
   * {@link EditorHandle.loadImage} applies to inbound urls, for the same
   * reason: the frame must never be aimed at its own origin on a host's
   * behalf. Anything else rejects with `invalid_input`.
   */
  url: string;
  /** HTTP method. Defaults to `'PUT'` — what S3/R2/GCS/Azure presigned upload urls expect. */
  method?: 'PUT' | 'POST';
  /**
   * Extra request headers, e.g. the `x-amz-*` headers you signed into the url.
   *
   * Allowlisted (case-insensitive) to `content-type`, `cache-control`,
   * `content-disposition` and the `x-amz-`/`x-goog-`/`x-ms-` prefixes, at most
   * 16 entries; anything else rejects with `invalid_input`. `Content-Type`
   * defaults to the exported blob's mime type — pass your own to override it.
   */
  headers?: Record<string, string>;
  /** What to render, from the same union {@link EditorHandle.export} takes. Defaults to `'png'`. */
  format?: EmbedExportFormat;
}

/**
 * What a successful {@link EditorHandle.exportTo} resolves with. A non-2xx
 * response REJECTS (`upload_failed`) rather than resolving with `ok: false`,
 * so `ok` is always `true` — it is there to make `if (result.ok)` read the
 * way a host expects, not to signal a failure you have to check for.
 */
export interface EmbedExportToResult {
  ok: true;
  /** The bucket's response status (2xx). */
  status: number;
  /** Size of the uploaded body in bytes. */
  bytes: number;
  /** Mime type sent as `Content-Type`. */
  mime: string;
  /** Same dimensions {@link EditorHandle.export} reports for this format. */
  width: number;
  height: number;
  /**
   * The response's `ETag`, when the bucket exposes it. `null` when it does
   * not: a cross-origin response only reveals headers named in its
   * `Access-Control-Expose-Headers`, so add `ETag` there to receive it.
   */
  etag?: string | null;
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
  /**
   * Renders the document exactly as {@link EditorHandle.export} does, then
   * uploads the bytes straight from the editor frame to `target.url` — a
   * presigned upload url your backend minted for your own storage. The bytes
   * never touch your page or your server, and the browser uploads once.
   *
   * The request is `mode: 'cors'`, `credentials: 'omit'`,
   * `redirect: 'error'`: no cookies are ever sent, and the response body is
   * never read. Your bucket must therefore allow the method and the headers
   * from the EDITOR FRAME's origin (`https://snapnedit.com`, not your site's)
   * — see the CORS setup at <https://snapnedit.com/docs/embed>.
   *
   * Rejects with `invalid_input` (bad url, method, format or header),
   * `network_error` (the request never got a response — CORS, DNS, a
   * redirect), or `upload_failed` with `details: { status }` for a non-2xx.
   */
  exportTo(target: EmbedExportTarget, options?: EmbedExportOptions): Promise<EmbedExportToResult>;
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
