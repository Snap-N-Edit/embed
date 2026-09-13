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
 * Where {@link EditorHandle.exportTo} PUTs the rendered bytes when your own
 * backend minted the presigned upload url.
 *
 * The frame uploads straight from the iframe — your server never sees the
 * bytes, and the browser uploads once instead of handing them to your page to
 * re-send.
 */
export interface EmbedPresignedTarget {
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
 * Where {@link EditorHandle.exportTo} PUTs the rendered bytes when the bucket
 * is one your snapnedit account already has saved — a **storage destination**
 * (dashboard → Storage, or <https://snapnedit.com/docs/storage-destinations>).
 *
 * You provide only the destination's id: the frame asks the api for a signed
 * upload slot with its own embed session and PUTs into it. Nothing about the
 * bucket — its name, its region, least of all its credentials — reaches your
 * page, and your backend mints nothing. The bucket still needs a CORS rule
 * allowing `PUT` from the EDITOR FRAME's origin (`https://snapnedit.com`),
 * exactly as the presigned-url path does.
 *
 * Use {@link EditorHandle.listDestinations} to offer the account's
 * destinations as a picker.
 */
export interface EmbedSavedDestinationTarget {
  /** Id of a storage destination on the embed session's account. */
  destinationId: string;
  /**
   * Extra request headers, merged UNDER the ones the api signed — a signed
   * header always wins, since changing it would invalidate the signature.
   * Same allowlist and count limit as {@link EmbedPresignedTarget.headers}.
   */
  headers?: Record<string, string>;
  /** What to render, from the same union {@link EditorHandle.export} takes. Defaults to `'png'`. */
  format?: EmbedExportFormat;
}

/**
 * {@link EditorHandle.exportTo}'s destination: either a presigned url you
 * minted ({@link EmbedPresignedTarget}) or a saved storage destination on your
 * snapnedit account ({@link EmbedSavedDestinationTarget}). Exactly one of
 * `url` / `destinationId` — passing both, or neither, rejects with
 * `invalid_input`.
 */
export type EmbedExportTarget = EmbedPresignedTarget | EmbedSavedDestinationTarget;

/** Every storage backend a saved destination can point at. */
export type EmbedStorageProvider = 'aws-s3' | 'cloudflare-r2' | 'backblaze-b2' | 's3-compatible';

/**
 * One of the account's saved storage destinations, as
 * {@link EditorHandle.listDestinations} reports it — enough to render a
 * picker, and deliberately nothing more: no region, no endpoint, no key
 * fragment reaches the host page.
 */
export interface EmbedDestinationSummary {
  id: string;
  name: string;
  provider: EmbedStorageProvider;
  bucket: string;
  /** True for the destination the account delivers to when a job names none. */
  isDefault: boolean;
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
  /**
   * The object key the bytes were written to. Present ONLY for a
   * {@link EmbedSavedDestinationTarget} upload — a presigned url you minted
   * yourself already encodes the key you chose.
   */
  key?: string;
  /** The bucket the bytes were written to. Present only for a {@link EmbedSavedDestinationTarget} upload. */
  bucket?: string;
}
export type JobEventStatus = 'started' | 'succeeded' | 'failed';

/**
 * The `job` event's payload — one per lifecycle transition of an AI
 * operation the frame ran (`started`, then exactly one of
 * `succeeded`/`failed`).
 *
 * This is the host's METERING hook: everything needed to bill (or rate-limit,
 * or audit) your own end users is on it, so you never have to reconcile
 * against snapnedit's api. Attribute it with {@link EmbedJobEvent.endUserId},
 * which is whatever `endUserId` you minted the embed token with.
 */
export interface EmbedJobEvent {
  operation: OperationId;
  status: JobEventStatus;
  jobId?: string;
  /**
   * Credits this job costs your account.
   *
   * On `started` it is the operation's PUBLISHED cost — the estimate, before
   * the server has weighed in. On `succeeded`/`failed` it is what the server
   * actually reported for the job (`0` for a free operation, and `0` for a
   * {@link EmbedJobEvent.cached} result, which is not billed twice). Bill off
   * the terminal event, not the `started` one.
   */
  credits: number;
  /**
   * `true` when the result came back from snapnedit's content-addressed cache
   * rather than being computed: the same image, the same operation and the
   * same params had already been run. Cached results are not billed, so a
   * host metering its own users should not bill for one either.
   *
   * Always `false` on `started` (nothing is known yet) and on `failed`.
   */
  cached: boolean;
  /**
   * `true` when the job existed only to DELIVER an already-computed result
   * into a storage destination — the cache-hit-with-a-destination case, where
   * no operation ran. Like {@link EmbedJobEvent.cached}, it is not billed.
   */
  deliveryOnly: boolean;
  durationMs?: number;
  error?: { code: EmbedErrorCode; message: string };
  endUserId?: string;
}

export interface EmbedEvents {
  ready: { version: string };
  change: { dirty: boolean; pageCount: number };
  selection: { ids: string[]; kind: string | null };
  job: EmbedJobEvent;
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
   *
   * Instead of a `url` you may name a **saved storage destination** on your
   * snapnedit account — `exportTo({ destinationId })`. The frame then gets the
   * signed slot from the api itself with its own embed session, your backend
   * mints nothing, and the result additionally carries the `key` and `bucket`
   * the bytes landed at. See {@link EmbedSavedDestinationTarget}.
   */
  exportTo(target: EmbedExportTarget, options?: EmbedExportOptions): Promise<EmbedExportToResult>;
  /**
   * The saved storage destinations on the embed session's account, so you can
   * offer them as a picker and pass the chosen `id` to
   * {@link EditorHandle.exportTo}. Resolves with `[]` when the account has
   * none.
   *
   * Only what a picker needs is returned (id, name, provider, bucket, which
   * one is the default) — never a region, an endpoint, or any part of a
   * credential.
   */
  listDestinations(): Promise<EmbedDestinationSummary[]>;
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
