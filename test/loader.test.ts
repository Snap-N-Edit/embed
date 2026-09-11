import { describe, expect, test } from 'vitest';
import { parseScriptConfig } from '../src/loader.js';

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
