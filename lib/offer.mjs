// Direct (v3) pairing offer: the same shape as @getpaseo/protocol DirectConnectionOfferSchema
// (paseo branch release/installer). The daemon's own modules make the server id, key pair and QR,
// so the files match what the daemon loads.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LINK_SCHEME } from "./util.mjs";

// The app's own scheme (dinobot://pair), never a web page: the offer holds the password.
export const DIRECT_OFFER_BASE_URL = `${LINK_SCHEME}://pair`;

function serverModule(app, file) {
  return import(pathToFileURL(join(app, "daemon", "node_modules", "@getpaseo", "server", "dist", "server", "server", file)).href);
}

/** Endpoints best first: MagicDNS name, then the tailnet IP (tailnet only; no LAN, .local or localhost). */
export function offerEndpoints({ port, tailscale }) {
  const list = [];
  if (tailscale?.running && tailscale.dnsName) list.push(`${tailscale.dnsName}:${port}`);
  if (tailscale?.running && tailscale.ip) list.push(`${tailscale.ip}:${port}`);
  return [...new Set(list)];
}

export function buildOffer({ serverId, daemonPublicKeyB64, endpoints, password, tsLoginUrl }) {
  if (!serverId || !daemonPublicKeyB64 || !endpoints?.length) throw new Error("offer needs serverId, key and endpoints");
  return {
    v: 3,
    serverId,
    daemonPublicKeyB64,
    endpoints,
    ...(password ? { password } : {}),
    ...(tsLoginUrl ? { tsLoginUrl } : {}),
  };
}

export function offerUrl(offer) {
  return `${DIRECT_OFFER_BASE_URL}/#offer=${Buffer.from(JSON.stringify(offer), "utf8").toString("base64url")}`;
}

/** Creates (or loads) the daemon's server id and key pair in PASEO_HOME, before the daemon starts. */
export async function daemonIdentity(app, paseoHome) {
  const { getOrCreateServerId } = await serverModule(app, "server-id.js");
  const { loadOrCreateDaemonKeyPair } = await serverModule(app, "daemon-keypair.js");
  const serverId = getOrCreateServerId(paseoHome);
  const { publicKeyB64 } = await loadOrCreateDaemonKeyPair(paseoHome);
  return { serverId, daemonPublicKeyB64: publicKeyB64 };
}

export async function renderQr(app, url) {
  const { renderPairingQr } = await serverModule(app, "pairing-qr.js");
  return renderPairingQr(url);
}

/**
 * Printed under the QR: how to pair the DinoBot desktop app (a computer has no camera to scan
 * with). `dinobot pair --link` prints the same pairing link as text for the app's "Paste pairing
 * link". ~/.dinobot/bin is not on PATH, so the command is the full path, with ~ for the home.
 */
export function desktopPairLines({ bin, home }, { product, productId }) {
  const command = `${home && bin.startsWith(`${home}/`) ? `~${bin.slice(home.length)}` : bin}/${productId} pair --link`;
  return [
    `On a computer? In the ${product} desktop app, click "Paste pairing link" and paste what this prints:`,
    `  ${command}`,
  ];
}
