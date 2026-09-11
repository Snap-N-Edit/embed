import { describe, expect, test } from 'vitest';
import { embedFrameUrl, isProtocolMessage, isTrustedEvent, newRequestId, stripFunctions } from '../src/protocol.js';

describe('protocol', () => {
  test('isProtocolMessage accepts only version-1 envelopes with a string type', () => {
    expect(isProtocolMessage({ snapnedit: 1, type: 'ready' })).toBe(true);
    expect(isProtocolMessage({ snapnedit: 2, type: 'ready' })).toBe(false);
    expect(isProtocolMessage({ type: 'ready' })).toBe(false);
    expect(isProtocolMessage('ready')).toBe(false);
    expect(isProtocolMessage(null)).toBe(false);
  });
  test('isTrustedEvent requires BOTH the expected source and origin', () => {
    const src = {};
    const ev = { source: src, origin: 'https://a.test' } as unknown as MessageEvent;
    expect(isTrustedEvent(ev, src, 'https://a.test')).toBe(true);
    expect(isTrustedEvent(ev, {}, 'https://a.test')).toBe(false);
    expect(isTrustedEvent(ev, src, 'https://b.test')).toBe(false);
  });
  test('stripFunctions drops function-valued keys (getToken never crosses postMessage)', () => {
    const out = stripFunctions({ publishableKey: 'pk', getToken: async () => 't', theme: { accent: '#f00' } });
    expect(out).toEqual({ publishableKey: 'pk', theme: { accent: '#f00' } });
  });
  test('embedFrameUrl encodes the host origin into the query', () => {
    expect(embedFrameUrl('https://snapnedit.com', 'http://localhost:5173')).toBe('https://snapnedit.com/embed?host=http%3A%2F%2Flocalhost%3A5173');
  });
  test('request ids are unique', () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});
