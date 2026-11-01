export type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
  WebSocketFactory,
  WebSocketLike,
} from "./daemon-client-transport-types.js";
export {
  decodeMessageData,
  describeTransportClose,
  describeTransportError,
  encodeUtf8String,
  extractRelayMessage,
  normalizeTransportPayload,
  safeRandomId,
} from "./daemon-client-transport-utils.js";
export {
  createDirectE2eeUpgradeTransportFactory,
  createEncryptedTransport,
  createRelayE2eeTransportFactory,
  createRelayUpgradeTransportFactory,
  DIRECT_E2EE_FAILED_MESSAGE,
  describeDirectE2eeFailure,
  describeEndpointSecurityClose,
} from "./daemon-client-relay-e2ee-transport.js";
export {
  bindWsHandler,
  createWebSocketTransportFactory,
  defaultWebSocketFactory,
} from "./daemon-client-websocket-transport.js";
