import type { ErrorCode, OperationId } from '@snapnedit/shared';
import type { Document } from '@snapnedit/editor-core';

/**
 * `tsconfig.check.json` type-checks this package's `src` with only `lib: ES2022`
 * (no DOM). A full `/// <reference lib="dom" />` would fix that, but — verified
 * empirically — it also flips a `typeof globalThis extends { onmessage: any }`
 * conditional inside `@types/node`'s bundled `fetch.d.ts`, which changes how
 * `BodyInit` resolves program-wide and breaks an unrelated file
 * (`packages/sdk/src/client.ts`) that the typecheck gate must not touch.
 * Declaring only the one DOM-only name actually used below avoids that global
 * side effect; it merges harmlessly with the real `lib.dom.d.ts` declaration
 * under this package's own `tsconfig.json` (full DOM lib) used for `npm run build`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface HTMLIFrameElement {}
}

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

export type EmbedErrorCode = ErrorCode | 'not_ready' | 'mask_required' | 'timeout' | 'origin_denied' | 'destroyed';

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
  error: { code: EmbedErrorCode; message: string };
  'token-expiring': { expiresAt: string };
}
export type EmbedEventName = keyof EmbedEvents;

export interface EditorHandle {
  loadImage(src: string | Blob | File, opts?: { name?: string }): Promise<void>;
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
