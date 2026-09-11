import { describe, expect, test } from 'vitest';
import { parseScriptConfig, resolveLoaderScript } from '../src/loader.js';

describe('parseScriptConfig', () => {
  test('reads data-key, data-target, data-config JSON and derives origin from src', () => {
    const el = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_x', target: '#editor', config: '{"theme":{"accent":"#f00"}}' } as DOMStringMap };
    expect(parseScriptConfig(el)).toEqual({ target: '#editor', config: { publishableKey: 'pk_live_x', origin: 'https://snapnedit.com', theme: { accent: '#f00' } } });
  });
  test('data-token wins over nothing; invalid data-config is ignored', () => {
    const el = { src: 'http://localhost:3000/embed/v1.js', dataset: { token: 't', config: '{oops' } as DOMStringMap };
    expect(parseScriptConfig(el)).toEqual({ target: null, config: { token: 't', origin: 'http://localhost:3000' } });
  });
});

describe('resolveLoaderScript', () => {
  /** Minimal `document` stand-in: a fixed `currentScript` plus a canned answer for the loader selector. */
  function doc(currentScript: unknown, matches: unknown[] = []) {
    return {
      currentScript: currentScript as Element | null,
      querySelectorAll: (selector: string) => {
        // The real DOM would filter; asserting the selector here is what pins
        // the contract (data-key OR data-token, on OUR script src).
        expect(selector).toBe('script[data-key][src*="/embed/v1.js"], script[data-token][src*="/embed/v1.js"]');
        return matches as ArrayLike<Element>;
      },
    };
  }

  test('uses document.currentScript when the loader runs synchronously from its own tag', () => {
    const current = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_x' } };
    const other = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_other' } };
    expect(resolveLoaderScript(doc(current, [other]))).toBe(current);
  });

  test('falls back to the LAST matching script tag when currentScript is null (defer/async/module)', () => {
    const first = { src: 'https://snapnedit.com/embed/v1.js', dataset: { key: 'pk_live_1' } };
    const last = { src: 'https://snapnedit.com/embed/v1.js', dataset: { token: 't2' } };
    expect(resolveLoaderScript(doc(null, [first, last]))).toBe(last);
  });

  test('returns null when currentScript is null and nothing matches', () => {
    expect(resolveLoaderScript(doc(null, []))).toBeNull();
  });
});
