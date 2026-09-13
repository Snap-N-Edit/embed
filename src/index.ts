export * from './types.js';
export {
  PROTOCOL_VERSION,
  DEFAULT_EMBED_ORIGIN,
  EDITOR_METHODS,
  LONG_RUNNING_METHODS,
  EMBED_EVENT_NAMES,
  EMBED_ERROR_CODES,
  EMBED_TRANSPORTS,
  NATIVE_TRANSPORT,
  NATIVE_BRIDGE_GLOBAL,
  NATIVE_CHANNEL_NAME,
  NATIVE_FLUTTER_CHANNEL_NAME,
  NATIVE_QUERY_PARAMS,
  NATIVE_OUTBOUND_CHANNELS,
} from './protocol.js';
export type { EmbedTransport, NativeChannelId, ProtocolError } from './protocol.js';
export { mount } from './mount.js';
export type { MountDeps, WindowLike, DocumentLike } from './mount.js';
export const version = '0.3.1';
