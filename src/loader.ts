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

/** IIFE entry: exposes `window.Snapnedit` and auto-mounts when the script tag carries `data-key`/`data-token`. */
export function installLoader(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.Snapnedit = { mount, version };
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script || !(script.dataset.key || script.dataset.token)) return;
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
