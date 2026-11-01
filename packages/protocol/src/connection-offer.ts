import { z } from "zod";

/**
 * Relay-only pairing offer.
 *
 * `serverId` is a stable daemon identifier scoped to `PASEO_HOME`, and is also
 * used as the relay session identifier.
 */
export const ConnectionOfferV2Schema = z.object({
  v: z.literal(2),
  serverId: z.string().min(1),
  daemonPublicKeyB64: z.string().min(1),
  relay: z.object({
    endpoint: z.string().min(1),
    useTls: z.boolean().optional(),
  }),
  // COMPAT(relayProtectedSecurity): added in v0.13.0. Present when the daemon requires
  // protected endpoint security; clients pin it before their first handshake.
  minimumSecurityMode: z.literal("protected").optional(),
});

export type ConnectionOfferV2 = z.infer<typeof ConnectionOfferV2Schema>;

export const ConnectionOfferSchema = ConnectionOfferV2Schema;
export type ConnectionOffer = ConnectionOfferV2;

/**
 * Direct pairing offer (v3): no relay. The app races `endpoints` (best first: tailnet name, tailnet
 * IP, `<host>.local`, LAN IP, localhost), keeps the first that answers with this `serverId`, and
 * saves every endpoint as a direct connection so it can fail over later.
 *
 * Direct sockets are not end-to-end encrypted today (only the relay is), so the daemon password
 * travels in the offer: the QR is a secret, shown only on the host's own terminal or an already
 * authenticated client. `daemonPublicKeyB64` is carried for the fingerprint shown before saving
 * and for a later key-pinned direct channel. `tsLoginUrl` is reserved for an embedded Tailscale
 * login (not built).
 */
export const DirectConnectionOfferSchema = z.object({
  v: z.literal(3),
  serverId: z.string().min(1),
  daemonPublicKeyB64: z.string().min(1),
  endpoints: z.array(z.string().min(1)).min(1),
  useTls: z.boolean().optional(),
  password: z.string().min(1).optional(),
  tsLoginUrl: z.string().url().optional(),
});

export type DirectConnectionOffer = z.infer<typeof DirectConnectionOfferSchema>;

export type PairingOffer =
  | { kind: "relay"; offer: ConnectionOffer }
  | { kind: "direct"; offer: DirectConnectionOffer };

function decodeBase64UrlToUtf8(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function decodeOfferFragmentPayload(encoded: string): unknown {
  const json = decodeBase64UrlToUtf8(encoded);
  return JSON.parse(json) as unknown;
}

const OFFER_FRAGMENT_PREFIX = "#offer=";

function extractOfferFragmentEncoded(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fragmentIndex = trimmed.indexOf(OFFER_FRAGMENT_PREFIX);
  if (fragmentIndex === -1) return null;
  const encoded = trimmed.slice(fragmentIndex + OFFER_FRAGMENT_PREFIX.length).trim();
  return encoded.length > 0 ? encoded : null;
}

/**
 * Parse a pairing-offer URL of the form `https://app.paseo.sh/#offer=<base64url>`.
 *
 * Returns `null` if the input has no `#offer=` fragment. Throws if the fragment
 * exists but the payload is malformed or fails schema validation.
 */
export function parseConnectionOfferFromUrl(input: string): ConnectionOffer | null {
  const encoded = extractOfferFragmentEncoded(input);
  if (!encoded) return null;
  const payload = decodeOfferFragmentPayload(encoded);
  return ConnectionOfferSchema.parse(payload);
}

/**
 * Parse any `#offer=` link: a relay offer (v2) or a direct offer (v3). Returns `null` without an
 * `#offer=` fragment; throws when the payload is malformed or matches neither version.
 */
export function parsePairingOfferFromUrl(input: string): PairingOffer | null {
  const encoded = extractOfferFragmentEncoded(input);
  if (!encoded) return null;
  const payload = decodeOfferFragmentPayload(encoded);
  const version = (payload as { v?: unknown } | null)?.v;
  if (version === 3) return { kind: "direct", offer: DirectConnectionOfferSchema.parse(payload) };
  return { kind: "relay", offer: ConnectionOfferSchema.parse(payload) };
}
