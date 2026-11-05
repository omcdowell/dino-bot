/**
 * Avatar designer, shared by the server and the app: the options pack (shipped in the app, versioned),
 * the avatar.json schema, and composeAvatarSvg (avatar.json + pack -> SVG markup).
 */
import { AVATAR_PACK_V1, AVATAR_PACK_V1_JSON } from "./pack-v1";

export * from "./pack";
export * from "./schema";
export * from "./compose";
export { AVATAR_PACK_V1, AVATAR_PACK_V1_JSON };

/** The pack this build ships. */
export const AVATAR_PACK = AVATAR_PACK_V1;
export const AVATAR_PACK_JSON = AVATAR_PACK_V1_JSON;
export const AVATAR_PACK_VERSION = AVATAR_PACK_V1.packVersion;
