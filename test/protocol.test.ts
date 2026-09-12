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
  test('stripFunctions strips NESTED functions, in plain objects and inside arrays', () => {
    const out = stripFunctions({
      theme: { accent: '#f00', onPick: () => 'x', deep: { fn: () => 'y', keep: 1 } },
      features: { tools: ['text', 'shapes'], hooks: [() => 'a', { cb: () => 'b', keep: true }] },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      theme: { accent: '#f00', deep: { keep: 1 } },
      // A function in an array keeps its slot as `null` so later indices don't shift.
      features: { tools: ['text', 'shapes'], hooks: [null, { keep: true }] },
    });
  });
  test('stripFunctions leaves non-plain values (Blob, File, Date, ArrayBuffer, typed arrays) by reference', () => {
    const blob = new Blob(['x']);
    const file = new File(['x'], 'x.png');
    const date = new Date(0);
    const buffer = new ArrayBuffer(8);
    const bytes = new Uint8Array([1, 2, 3]);
    const out = stripFunctions({ image: blob, file, date, buffer, bytes, nested: { blob } }) as Record<string, unknown>;
    expect(out.image).toBe(blob);
    expect(out.file).toBe(file);
    expect(out.date).toBe(date);
    expect(out.buffer).toBe(buffer);
    expect(out.bytes).toBe(bytes);
    expect((out.nested as { blob: Blob }).blob).toBe(blob);
  });
  test('stripFunctions copies rather than mutates, and survives cycles/shared references', () => {
    const shared = { keep: 1, fn: () => 'x' };
    const input: Record<string, unknown> = { a: shared, b: shared };
    input.self = input;
    const out = stripFunctions(input) as Record<string, unknown>;
    expect(input.a).toBe(shared);
    expect(shared.fn).toBeTypeOf('function');
    expect(out.a).toEqual({ keep: 1 });
    expect(out.a).toBe(out.b);
    expect(out.self).toBe(out);
  });
  test('embedFrameUrl encodes the host origin into the query', () => {
    expect(embedFrameUrl('https://snapnedit.com', 'http://localhost:5173')).toBe('https://snapnedit.com/embed?host=http%3A%2F%2Flocalhost%3A5173');
  });
  test('request ids are unique', () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});
