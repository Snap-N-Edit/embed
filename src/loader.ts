// IIFE entry point for the `<script src=".../embed/v1.js">` loader. Never
// imported by src/index.ts (the ESM barrel) — this module installs a global
// and auto-mounts as a side effect, which the barrel must stay free of.
import { mount } from './mount.js';
import type { EmbedConfig } from './types.js';

export const version = '0.1.0';

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
}

/**
 * Matches a `<script src=".../embed/v1.js" data-key|data-token>` tag anywhere
 * in the document — the fallback used when `document.currentScript` is null.
 */
const LOADER_SCRIPT_SELECTOR = 'script[data-key][src*="/embed/v1.js"], script[data-token][src*="/embed/v1.js"]';

/** The slice of `document` {@link resolveLoaderScript} reads — injectable so the resolution is unit-testable without a DOM. */
export interface LoaderDocumentLike {
  currentScript: Element | null;
  querySelectorAll(selector: string): ArrayLike<Element>;
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
 * document for our own script tag; the LAST match wins, since that is the one
 * that most recently executed when a page carries several.
 */
export function resolveLoaderScript(doc: LoaderDocumentLike): HTMLScriptElement | null {
  if (doc.currentScript) return doc.currentScript as HTMLScriptElement;
  const matches = doc.querySelectorAll(LOADER_SCRIPT_SELECTOR);
  return matches.length > 0 ? ((matches[matches.length - 1] ?? null) as HTMLScriptElement | null) : null;
}

/** IIFE entry: exposes `window.Snapnedit` and auto-mounts when the script tag carries `data-key`/`data-token`. */
export function installLoader(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.Snapnedit = { mount, version };
  const script = resolveLoaderScript(document);
  if (!script) {
    // Nothing to auto-mount from and no way to find our own tag — say so
    // rather than failing silently, which is what made this bug invisible.
    console.warn('[snapnedit embed] no script tag with data-key/data-token found; call window.Snapnedit.mount() manually');
    return;
  }
  // A loader tag with no credentials is the legitimate "I'll call mount()
  // myself" case, not a misconfiguration — stay quiet.
  if (!(script.dataset.key || script.dataset.token)) return;
  const { config, target } = parseScriptConfig(script);
  let container: HTMLElement | null = target ? document.querySelector(target) : null;
  if (!container) {
    container = document.createElement('div');
    container.style.cssText = 'width:100%;height:640px;';
    script.insertAdjacentElement('afterend', container);
  }
  void mount(container, config).catch((err: unknown) => console.error('[snapnedit embed]', err));
}

installLoader();
