export {
  openClientSecureChannel,
  openDaemonSecureChannel,
  prepareClientSecureHandshake,
  readUpgradeCarrier,
  UPGRADE_CARRIER_ACCEPTED_SUBPROTOCOL,
  UPGRADE_CARRIER_MSG1_PREFIX,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_REASON,
  PROTECTED_RECORD_FAILED_CLOSE_CODE,
  SecureChannelRejectedError,
} from "./secure-channel.js";
export type {
  ClientSecureChannelOptions,
  DaemonSecureChannelOptions,
  PreparedClientHandshake,
  SecureChannel,
  SecureChannelEvents,
  SecurityMode,
} from "./secure-channel.js";

export { createClientChannel, createDaemonChannel, EncryptedChannel } from "./encrypted-channel.js";
export type { Transport, TransportMessage, EncryptedChannelEvents } from "./encrypted-channel.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportSecretKey,
  importSecretKey,
} from "./crypto.js";
export type { KeyPair, SharedKey } from "./crypto.js";
