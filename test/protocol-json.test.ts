import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  EDITOR_METHODS,
  EMBED_ERROR_CODES,
  EMBED_EVENT_NAMES,
  EMBED_TRANSPORTS,
  LONG_RUNNING_METHODS,
  NATIVE_BRIDGE_GLOBAL,
  NATIVE_CHANNEL_NAME,
  NATIVE_FLUTTER_CHANNEL_NAME,
  NATIVE_OUTBOUND_CHANNELS,
  NATIVE_QUERY_PARAMS,
  PROTOCOL_VERSION,
} from '../src/protocol.js';
import { version as packageVersion } from '../src/index.js';

/**
 * `protocol.json` is what a Swift / C# / Kotlin / Dart wrapper author reads
 * instead of this TypeScript. It is hand-written (a generator would have to
 * invent JSON Schema for `Document`, `EmbedTheme`, …, which helps nobody), so
 * THIS is what stops it drifting: every method, event, error code and
 * transport the types know about must appear in the file, and nothing may
 * appear in the file that the types don't know about.
 *
 * A failure here means one of two edits is missing, not that the test is
 * wrong: add the entry to `protocol.json`, or drop the stale one.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(path.join(HERE, '..', 'protocol.json'), 'utf8');

interface ProtocolDoc {
  version: number;
  packageVersion: string;
  transports: string[];
  envelope: { discriminator: string; discriminatorValue: number; hostToFrame: { type: string }[]; frameToHost: { type: string }[] };
  methods: Record<string, { params: string[]; result: string; longRunning: boolean }>;
  events: Record<string, { payload: Record<string, unknown> }>;
  errorCodes: string[];
  native: {
    inbound: string;
    channelName: string;
    flutterChannelName: string;
    queryParams: Record<string, unknown>;
    outboundChannels: { id: string; expression: string }[];
    buffering: { maxBufferedMessages: number };
  };
}

const doc = JSON.parse(RAW) as ProtocolDoc;

describe('protocol.json', () => {
  test('is valid JSON and pinned to this protocol/package version', () => {
    expect(doc.version).toBe(PROTOCOL_VERSION);
    expect(doc.packageVersion).toBe(packageVersion);
    expect(doc.envelope.discriminatorValue).toBe(PROTOCOL_VERSION);
    expect(doc.envelope.discriminator).toBe('snapnedit');
  });

  test('lists every transport', () => {
    expect(doc.transports).toEqual([...EMBED_TRANSPORTS]);
  });

  test('lists every message type in both directions', () => {
    expect(doc.envelope.hostToFrame.map((m) => m.type)).toEqual(['init', 'call', 'refresh-token']);
    expect(doc.envelope.frameToHost.map((m) => m.type)).toEqual(['ready-for-init', 'event', 'result']);
  });

  test('documents every method, and no method that does not exist', () => {
    expect(Object.keys(doc.methods).sort()).toEqual([...EDITOR_METHODS].sort());
  });

  test('every method entry carries params/result/longRunning, and longRunning agrees with the loader', () => {
    const long = new Set<string>(LONG_RUNNING_METHODS);
    for (const [name, entry] of Object.entries(doc.methods)) {
      expect(Array.isArray(entry.params), `${name}.params`).toBe(true);
      expect(typeof entry.result, `${name}.result`).toBe('string');
      expect(entry.longRunning, `${name}.longRunning`).toBe(long.has(name));
    }
  });

  test('documents every event, and no event that does not exist', () => {
    expect(Object.keys(doc.events).sort()).toEqual([...EMBED_EVENT_NAMES].sort());
    for (const [name, entry] of Object.entries(doc.events)) {
      expect(typeof entry.payload, `${name}.payload`).toBe('object');
    }
  });

  test('lists every error code, in the same order, with no extras', () => {
    expect(doc.errorCodes).toEqual([...EMBED_ERROR_CODES]);
  });

  test('the native section matches the constants the frame actually uses', () => {
    expect(doc.native.inbound).toBe(`${NATIVE_BRIDGE_GLOBAL}.receive`);
    expect(doc.native.channelName).toBe(NATIVE_CHANNEL_NAME);
    expect(doc.native.flutterChannelName).toBe(NATIVE_FLUTTER_CHANNEL_NAME);
    expect(Object.keys(doc.native.queryParams)).toEqual([...NATIVE_QUERY_PARAMS]);
    expect(doc.native.outboundChannels.map((c) => c.id)).toEqual(NATIVE_OUTBOUND_CHANNELS.map((c) => c.id));
    expect(doc.native.outboundChannels.map((c) => c.expression)).toEqual(NATIVE_OUTBOUND_CHANNELS.map((c) => c.expression));
  });

  test('the native app-id pattern accepts and rejects the same ids the api does', () => {
    const params = doc.native.queryParams as { origin: { pattern: string } };
    const re = new RegExp(params.origin.pattern);
    for (const ok of ['native:com.acme.photos', 'native:acme-desktop', 'native:a_b', `native:${'a'.repeat(128)}`]) {
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of ['native:', 'native:a', 'native:.dot', 'native:has space', `native:${'a'.repeat(129)}`, 'https://a.b']) {
      expect(re.test(bad), bad).toBe(false);
    }
  });

  test('is shipped with the package', () => {
    const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')) as {
      files: string[];
      exports: Record<string, unknown>;
    };
    expect(pkg.files).toContain('protocol.json');
    expect(pkg.exports['./protocol.json']).toBe('./protocol.json');
  });
});
