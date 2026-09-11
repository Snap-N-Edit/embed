import type { EditorMethod, EmbedEventName, EmbedEvents, EmbedErrorCode, FrameConfig } from './types.js';

export const PROTOCOL_VERSION = 1 as const;
export const EMBED_PATH = '/embed';
export const DEFAULT_EMBED_ORIGIN = 'https://snapnedit.com';

export type HostToFrameMessage =
  | { snapnedit: 1; type: 'init'; payload: { config: FrameConfig } }
  | { snapnedit: 1; type: 'call'; id: string; payload: { method: EditorMethod; args: unknown[] } }
  | { snapnedit: 1; type: 'refresh-token'; payload: { token: string } };

export type FrameToHostMessage =
  | { snapnedit: 1; type: 'ready-for-init' }
  | { snapnedit: 1; type: 'event'; payload: { name: EmbedEventName; data: EmbedEvents[EmbedEventName] } }
  | { snapnedit: 1; type: 'result'; id: string; payload: { ok: true; value: unknown } | { ok: false; error: { code: EmbedErrorCode; message: string } } };

export type ProtocolMessage = HostToFrameMessage | FrameToHostMessage;

export function isProtocolMessage(data: unknown): data is ProtocolMessage {
  return typeof data === 'object' && data !== null
    && (data as { snapnedit?: unknown }).snapnedit === PROTOCOL_VERSION
    && typeof (data as { type?: unknown }).type === 'string';
}

/** Browser-enforced trust: the message must come from exactly the window AND origin we expect. */
export function isTrustedEvent(event: MessageEvent, expectedSource: unknown, expectedOrigin: string): boolean {
  return event.source === expectedSource && event.origin === expectedOrigin;
}

/** Removes function-valued keys (shallow) so the object is structured-cloneable. */
export function stripFunctions<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'function') out[k] = v;
  }
  return out as T;
}

let counter = 0;
export function newRequestId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function embedFrameUrl(embedOrigin: string, hostOrigin: string): string {
  return `${embedOrigin.replace(/\/+$/, '')}${EMBED_PATH}?host=${encodeURIComponent(hostOrigin)}`;
}
