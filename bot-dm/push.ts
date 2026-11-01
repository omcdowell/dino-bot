/**
 * The paseo-apns endpoint client lives in server/apns-push.ts (the bots plugin uses it too, and
 * plugin modules must sit under server/); bot-dm imports it from here.
 * Erasable TypeScript only: Node runs this file directly.
 */
export * from "../server/apns-push.ts";
