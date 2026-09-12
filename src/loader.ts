// IIFE entry point for the `<script src=".../embed/v1.js">` loader. Never
// imported by src/index.ts (the ESM barrel) — this module installs a global
// and auto-mounts as a side effect, which the barrel must stay free of.
import { mount } from './mount.js';
import type { EditorHandle, EmbedConfig, EmbedErrorCode, EmbedEvents } from './types.js';

export const version = '0.1.0';

/** Marks a `<script>` tag the loader has already auto-mounted from, so a second pass skips it. */
export const PROCESSED_ATTR = 'data-snapnedit-mounted';

/** DOM CustomEvent dispatched on the container once the editor is ready. `detail` is the `ready` payload plus the handle. */
export const READY_EVENT = 'snapnedit:ready';
/** DOM CustomEvent dispatched on the container for any error the editor reports, before or after `ready`. */
export const ERROR_EVENT = 'snapnedit:error';

export type ReadyEventDetail = EmbedEvents['ready'] & { editor: EditorHandle };
export type ErrorEventDetail = EmbedEvents['error'];

/** Pure: maps a `<script data-*>` tag to `mount()` inputs. `origin` is the script's own origin so self-hosted deployments need no config. */
export function parseScriptConfig(el: { dataset: DOMStringMap; src: string }): { config: EmbedConfig; target: string | null } {
  const config: EmbedConfig = {};
  if (el.dataset.config) {
    try { Object.assign(config, JSON.parse(el.dataset.config) as EmbedConfig); } catch { /* ignore malformed JSON; other attributes still apply */ }
  }
  if (el.dataset.key) config.publishableKey = el.dataset.key;
  if (el.dataset.token) config.token = el.dataset.token;
  if (el.dataset.locale) config.locale = el.dataset.locale;
  try { config.origin = new URL(el.src).origin; } catch { /* leave default */ }
  return { config, target: el.dataset.target ?? null };
}

declare global {
  interface Window { Snapnedit?: { mount: typeof mount; version: string } }
  interface HTMLElementEventMap {
    'snapnedit:ready': CustomEvent<ReadyEventDetail>;
    'snapnedit:error': CustomEvent<ErrorEventDetail>;
  }
}

/**
 * Matches a `<script src=".../embed/v1.js" data-key|data-token>` tag anywhere
 * in the document that this loader has not already mounted — the fallback used
 * when `document.currentScript` is null.
 */
const LOADER_SCRIPT_SELECTOR =
  `script[data-key][src*="/embed/v1.js"]:not([${PROCESSED_ATTR}]), script[data-token][src*="/embed/v1.js"]:not([${PROCESSED_ATTR}])`;

/** The slice of `document` {@link resolveLoaderScript} reads — injectable so the resolution is unit-testable without a DOM. */
export interface LoaderDocumentLike {
  currentScript: Element | null;
  querySelectorAll(selector: string): ArrayLike<Element>;
}

/** `data-snapnedit-mounted` in `dataset` form; tolerant of the plain-object stand-ins the unit tests inject. */
function isProcessed(el: HTMLScriptElement): boolean {
  return (el as { dataset?: DOMStringMap }).dataset?.snapneditMounted !== undefined;
}

/** Claims a tag: the same tag can never auto-mount twice, even if the loader script runs again. */
export function markLoaderScript(el: HTMLScriptElement): void {
  el.dataset.snapneditMounted = '';
}

/**
 * Finds the `<script>` tag whose `data-*` attributes configure the auto-mount.
 *
 * `document.currentScript` is the right answer whenever it exists, but it is
 * NULL in every case where the loader doesn't execute synchronously from its
 * own tag — most importantly a plain `defer`/`async` tag, but also a module
 * script, a dynamically-inserted tag, or execution from a callback. Auto-mount
 * used to silently do nothing in all of those, which is a perfectly ordinary
 * way to write the one-liner from the docs. So fall back to searching the
 * document for our own script tag.
 *
 * Either way an ALREADY-PROCESSED tag is never returned: with `currentScript`
 * null and two loader tags on the page, "last match wins" handed both
 * executions the same tag (double-mounting it and never mounting the other).
 * The first unprocessed match is the one that is still owed an editor.
 */
export function resolveLoaderScript(doc: LoaderDocumentLike): HTMLScriptElement | null {
  const current = doc.currentScript as HTMLScriptElement | null;
  if (current) return isProcessed(current) ? null : current;
  const matches = doc.querySelectorAll(LOADER_SCRIPT_SELECTOR);
  for (let i = 0; i < matches.length; i += 1) {
    const el = matches[i] as HTMLScriptElement | undefined;
    if (el && !isProcessed(el)) return el;
  }
  return null;
}

/** The slice of `document` {@link installLoader} needs on top of {@link LoaderDocumentLike}. */
export interface LoaderHostDocument extends LoaderDocumentLike {
  querySelector(selector: string): Element | null;
  createElement(tag: 'div'): HTMLElement;
}
export interface LoaderHostWindow { Snapnedit?: { mount: typeof mount; version: string } }
/** Injectable seams — the IIFE passes none of them and runs against the real globals. */
export interface InstallLoaderDeps {
  window?: LoaderHostWindow;
  document?: LoaderHostDocument;
  mount?: (target: HTMLElement, config: EmbedConfig) => Promise<EditorHandle>;
}

/** Fires a bubbling CustomEvent on the container; a stand-in element without `dispatchEvent` is simply skipped. */
function dispatchOn<T>(el: HTMLElement, type: string, detail: T): void {
  if (typeof CustomEvent !== 'function' || typeof el.dispatchEvent !== 'function') return;
  el.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true }));
}

/** IIFE entry: exposes `window.Snapnedit` and auto-mounts when the script tag carries `data-key`/`data-token`. */
export function installLoader(deps: InstallLoaderDeps = {}): void {
  const win = deps.window ?? (typeof window !== 'undefined' ? (window as LoaderHostWindow) : null);
  const doc = deps.document ?? (typeof document !== 'undefined' ? (document as unknown as LoaderHostDocument) : null);
  if (!win || !doc) return;
  const mountFn = deps.mount ?? ((target: HTMLElement, config: EmbedConfig) => mount(target, config));
  win.Snapnedit = { mount, version };
  const script = resolveLoaderScript(doc);
  if (!script) {
    // Nothing to auto-mount from and no way to find our own tag — say so
    // rather than failing silently, which is what made this bug invisible.
    console.warn('[snapnedit embed] no unmounted script tag with data-key/data-token found; call window.Snapnedit.mount() manually');
    return;
  }
  // A loader tag with no credentials is the legitimate "I'll call mount()
  // myself" case, not a misconfiguration — stay quiet.
  if (!(script.dataset.key || script.dataset.token)) return;
  // Claim the tag BEFORE mounting: a second synchronous execution (two copies
  // of v1.js, a re-inserted tag) must not race us into a duplicate editor.
  markLoaderScript(script);
  const { config, target } = parseScriptConfig(script);
  let container: HTMLElement | null = target ? (doc.querySelector(target) as HTMLElement | null) : null;
  if (!container) {
    container = doc.createElement('div');
    container.style.cssText = 'width:100%;height:640px;';
    script.insertAdjacentElement('afterend', container);
  }
  const el = container;
  void mountFn(el, config).then(
    (handle) => {
      // A script-tag embed has no handle to call `on()` on, so mirror the two
      // lifecycle events onto the container as DOM CustomEvents. Without this
      // an error AFTER boot (an expired token, a rejected refresh) was heard by
      // nobody — only the React wrapper subscribes to `error`.
      handle.on('ready', (payload) => dispatchOn<ReadyEventDetail>(el, READY_EVENT, { ...payload, editor: handle }));
      handle.on('error', (err) => {
        console.error(`[snapnedit embed] ${err.code}: ${err.message}`);
        dispatchOn<ErrorEventDetail>(el, ERROR_EVENT, err);
      });
    },
    (err: unknown) => {
      console.error('[snapnedit embed]', err);
      const e = err as { code?: EmbedErrorCode; message?: string } | null;
      dispatchOn<ErrorEventDetail>(el, ERROR_EVENT, { code: e?.code ?? 'internal', message: e?.message ?? String(err) });
    },
  );
}

installLoader();
