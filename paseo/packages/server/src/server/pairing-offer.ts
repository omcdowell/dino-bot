import type { Logger } from "pino";

import {
  buildDirectOfferEndpoints,
  isTailnetEndpoint,
  createConnectionOfferV2,
  createDirectConnectionOffer,
  encodeOfferToFragmentUrl,
} from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { renderPairingQr } from "./pairing-qr.js";
import { getOrCreateServerId } from "./server-id.js";

export interface LocalPairingOffer {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
  /** "direct" when the relay is off and a direct (v3) offer was built from the listen address. */
  kind?: "relay" | "direct";
  /** Why a direct offer is missing: no Tailscale endpoint (DIRECT_OFFER_TAILNET_ONLY). */
  reason?: "no_tailnet";
}

/**
 * Direct offers carry Tailscale endpoints only (privacy review 27 Oct: "Tailscale only, no
 * LAN mode"): no `<host>.local`, LAN IP or localhost. With no tailnet endpoint there is no offer
 * (`reason: "no_tailnet"`), and the setup tells the user to turn Tailscale on.
 */
export const DIRECT_OFFER_TAILNET_ONLY = true;

/** App-scheme link for direct offers; scanned in the app (or opens it), never a web page. */
export const DIRECT_OFFER_BASE_URL = "paseo://pair";

/**
 * Link base for direct offers. PASEO_PAIR_LINK_SCHEME picks the app's URL scheme (the public app
 * registers its own, from its name in packages/app/release-flavour.js, e.g. "dinobot"), so a
 * phone-camera scan opens that app; unset keeps paseo://pair.
 */
export function directOfferBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const scheme = (env.PASEO_PAIR_LINK_SCHEME ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? `${scheme}://pair` : DIRECT_OFFER_BASE_URL;
}

/** Direct pairing when the relay is off ("relay: not for now"). */
export interface DirectPairingArgs {
  /** The daemon's TCP listen address (`host:port`); sockets and pipes get no direct offer. */
  listen: string | null | undefined;
  /**
   * Daemon password (PASEO_PASSWORD), put in the offer so the phone can log in. The QR also carries
   * the daemon public key; an updated app runs the encrypted channel (DIRECT_E2EE_SUBPROTOCOL) on
   * every endpoint and sends this password only inside it, after the daemon has proved that key.
   */
  password?: string;
  /** Extra endpoints offered first, e.g. the MagicDNS name (PASEO_DIRECT_ENDPOINTS, comma list). */
  extraEndpoints?: string[];
}

function parseTcpListen(listen: string | null | undefined): { host: string; port: number } | null {
  const value = listen?.trim();
  if (!value || value.startsWith("/") || value.includes("://") || value.startsWith("\\\\"))
    return null;
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match) return null;
  const port = Number(match[2]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: match[1]!, port } : null;
}

/** Extra direct endpoints from `PASEO_DIRECT_ENDPOINTS` (comma separated `host:port`). */
export function directEndpointsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PASEO_DIRECT_ENDPOINTS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function renderQrOrNull(url: string, logger?: Logger): Promise<string | null> {
  try {
    return await renderPairingQr(url);
  } catch (error) {
    logger?.debug({ error }, "Failed to render pairing QR");
    return null;
  }
}

export async function generateLocalPairingOffer(args: {
  paseoHome: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  /** Stamp the offer so new clients require protected endpoint security from their first handshake. */
  relayRequireProtectedSecurity?: boolean;
  appBaseUrl?: string;
  includeQr?: boolean;
  logger?: Logger;
  direct?: DirectPairingArgs;
}): Promise<LocalPairingOffer> {
  const relayEnabled = args.relayEnabled ?? true;
  if (!relayEnabled) {
    const tcp = parseTcpListen(args.direct?.listen);
    if (!args.direct || !tcp) {
      return {
        relayEnabled: false,
        url: null,
        qr: null,
      };
    }
    const allEndpoints = buildDirectOfferEndpoints({
      listenHost: tcp.host,
      port: tcp.port,
      extra: args.direct.extraEndpoints,
    });
    const endpoints = DIRECT_OFFER_TAILNET_ONLY
      ? allEndpoints.filter(isTailnetEndpoint)
      : allEndpoints;
    if (endpoints.length === 0) {
      return { relayEnabled: false, url: null, qr: null, kind: "direct", reason: "no_tailnet" };
    }
    const serverId = getOrCreateServerId(args.paseoHome, { logger: args.logger });
    const daemonKeyPair = await loadOrCreateDaemonKeyPair(args.paseoHome, args.logger);
    const offer = createDirectConnectionOffer({
      serverId,
      daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
      endpoints,
      password: args.direct.password?.trim() || undefined,
    });
    // Never the web app base: the offer holds the password, and a phone camera would open a web page.
    const url = encodeOfferToFragmentUrl({ offer, appBaseUrl: directOfferBaseUrl() });
    const qr = args.includeQr === false ? null : await renderQrOrNull(url, args.logger);
    return { relayEnabled: false, url, qr, kind: "direct" };
  }

  const relayEndpoint = args.relayEndpoint ?? "relay.paseo.sh:443";
  const relayPublicEndpoint = args.relayPublicEndpoint ?? relayEndpoint;
  const relayUseTls = args.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
  const relayPublicUseTls = args.relayPublicUseTls ?? relayUseTls;
  const appBaseUrl = args.appBaseUrl ?? "https://app.paseo.sh";
  const serverId = getOrCreateServerId(args.paseoHome, { logger: args.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(args.paseoHome, args.logger);
  const offer = await createConnectionOfferV2({
    serverId,
    daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
    relay: { endpoint: relayPublicEndpoint, useTls: relayPublicUseTls },
    ...(args.relayRequireProtectedSecurity === true
      ? { minimumSecurityMode: "protected" as const }
      : {}),
  });
  const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });

  if (args.includeQr === false) {
    return {
      relayEnabled: true,
      url,
      qr: null,
    };
  }

  let qr: string | null = null;
  try {
    qr = await renderPairingQr(url);
  } catch (error) {
    args.logger?.debug({ error }, "Failed to render pairing QR");
  }

  return {
    relayEnabled: true,
    url,
    qr,
  };
}
