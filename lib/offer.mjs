// Direct (v3) pairing offer: the same shape as @getpaseo/protocol DirectConnectionOfferSchema
// (paseo branch release/installer). The daemon's own modules make the server id, key pair and QR,
// so the files match what the daemon loads.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LINK_SCHEME, PAIRING_QR } from "./util.mjs";

// The app's own scheme (dinobot://pair), never a web page: the offer holds a pairing secret.
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

export function buildOffer({ serverId, daemonPublicKeyB64, endpoints, password, pairingTicket, tsLoginUrl }) {
  if (!serverId || !daemonPublicKeyB64 || !endpoints?.length) throw new Error("offer needs serverId, key and endpoints");
  return {
    v: 3,
    serverId,
    daemonPublicKeyB64,
    endpoints,
    ...(pairingTicket ? { pairingTicket } : {}),
    ...(password ? { password } : {}),
    ...(tsLoginUrl ? { tsLoginUrl } : {}),
  };
}

/**
 * What the pairing code carries (QR2), from product.json `pairingQr` (DINOBOT_PAIRING_QR wins):
 * "ticket+password" (transition: apps without ticket support still pair) or "ticket" (never the
 * password). Anything else is read as "ticket+password", the mode that pairs every app.
 */
export function pairingQrMode(env = process.env) {
  const mode = env.DINOBOT_PAIRING_QR || PAIRING_QR;
  return mode === "ticket" ? "ticket" : "ticket+password";
}

/**
 * The pairing offer with a fresh one-use ticket (10 minutes, one device; the daemon's
 * pairing-tickets.js mints it into PASEO_HOME). A daemon without tickets (older build) gets the
 * password-only offer, which every app can use. -> { offer, mode, expiresAt }
 */
export async function pairingOffer(app, paseoHome, { identity, endpoints, password, env = process.env, mint }) {
  const mode = pairingQrMode(env);
  let minted = null;
  try {
    minted = await (mint ?? (async (home) => (await serverModule(app, "pairing-tickets.js")).mintPairingTicket(home)))(paseoHome);
  } catch {
    minted = null;
  }
  if (!minted?.ticket) return { offer: buildOffer({ ...identity, endpoints, password }), mode: "password", expiresAt: null };
  const offer = buildOffer({ ...identity, endpoints, pairingTicket: minted.ticket, ...(mode === "ticket" ? {} : { password }) });
  return { offer, mode, expiresAt: minted.expiresAt };
}

/** The line under the code: what it holds and how long it works. */
export function pairingCodeNote(mode, { productId }) {
  if (mode === "ticket") return `It works once, for 10 minutes. For another phone or computer, run \`${productId} pair\` again.`;
  return "It holds this computer's password: don't share a photo of it.";
}

/** `dinobot devices`: the paired devices (session-tokens.js listPairedDevices). */
export async function pairedDevices(app, paseoHome) {
  return (await serverModule(app, "session-tokens.js")).listPairedDevices(paseoHome);
}

/** Revokes devices (clientIds, or "all": also voids every unused pairing code). */
export async function revokeDevices(app, paseoHome, target) {
  (await serverModule(app, "session-tokens.js")).revokePairedDevices(paseoHome, target);
  if (target === "all") (await serverModule(app, "pairing-tickets.js")).rotatePairingTicketKey(paseoHome);
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
