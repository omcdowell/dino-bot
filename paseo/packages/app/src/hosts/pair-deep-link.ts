import { APP_DISPLAY_NAME, APP_LINK_SCHEME } from "@/constants/flavour";
import { DEVICE_COPY } from "@/constants/device-copy";

/**
 * Pairing deep links: `<scheme>://pair/#offer=…` (scheme from release-flavour.js: "paseo" for the
 * own build, the public app's own). A phone-camera scan of the installer's QR opens the app here;
 * src/app/+native-intent.tsx turns it into the /pair route, which pairs without the in-app camera.
 */

/** The pairing link inside an incoming URL or router path, or null if it is not one. */
export function pairLinkFromIncoming(input: string, scheme: string): string | null {
  const raw = input.trim();
  const marker = raw.indexOf("#offer=");
  if (marker < 0) return null;
  const head = raw.slice(0, marker).replace(/\/+$/, "");
  const fragment = raw.slice(marker);
  const prefix = `${scheme.toLowerCase()}://`;
  if (head.toLowerCase().startsWith(prefix)) {
    const rest = head.slice(prefix.length).replace(/^\/+/, "");
    return rest === "pair" ? `${prefix}pair/${fragment}` : null;
  }
  // The router may hand over the path only ("/pair#offer=…" or "pair/#offer=…").
  if (head.replace(/^\/+/, "") === "pair") return `${prefix}pair/${fragment}`;
  return null;
}

/**
 * Router path for an incoming URL: pairing links go to /pair with the link as a parameter.
 * `attempt` (a fresh value per incoming URL) makes the same link opened again, e.g. after Cancel
 * on the host confirmation, a new route the /pair screen restarts on (rel-demo bug 7); without
 * it the router saw the same URL and nothing happened until the app was restarted.
 */
export function routeForIncoming(input: string, scheme: string, attempt?: string): string | null {
  const link = pairLinkFromIncoming(input, scheme);
  if (!link) return null;
  const at = attempt ? `&at=${encodeURIComponent(attempt)}` : "";
  return `/pair?link=${encodeURIComponent(link)}${at}`;
}

/**
 * A provider invite link (`<scheme>://provider/add?source=…&token=…&name=…`, made by
 * `dinobot provider link` on the owner's computer). The provider is installed on the computer,
 * not the phone, so the app only shows what it is and copies the command to run there.
 * Returns the link as given plus the parts safe to show (never the token), or null.
 */
export interface ProviderInvite {
  link: string;
  name: string | null;
  source: string;
  hasToken: boolean;
}

export function providerInviteFromIncoming(input: string, scheme: string): ProviderInvite | null {
  const raw = input.trim();
  const prefix = `${scheme.toLowerCase()}://`;
  let rest: string;
  if (raw.toLowerCase().startsWith(prefix)) rest = raw.slice(prefix.length);
  else if (/^\/?provider\/add/.test(raw)) rest = raw.replace(/^\//, "");
  else return null;
  const q = rest.indexOf("?");
  const path = (q < 0 ? rest : rest.slice(0, q)).replace(/\/+$/, "");
  if (path !== "provider/add" || q < 0) return null;
  const params = new URLSearchParams(rest.slice(q + 1));
  const source = params.get("source")?.trim();
  if (!source) return null;
  return {
    // Re-encoded from the parsed values: the router may hand the URL over partly decoded.
    link: `${prefix}provider/add?${params.toString()}`,
    name: params.get("name")?.trim() || null,
    source,
    hasToken: Boolean(params.get("token")),
  };
}

/** The command that adds the provider on the computer (quoted for sh/zsh). */
export function providerAddCommand(invite: ProviderInvite, scheme: string): string {
  return `${scheme} provider add '${invite.link.replace(/'/g, "'\\''")}'`;
}

/** Router path for a provider invite link: the /provider-link screen. */
export function providerRouteForIncoming(input: string, scheme: string): string | null {
  const invite = providerInviteFromIncoming(input, scheme);
  return invite ? `/provider-link?link=${encodeURIComponent(invite.link)}` : null;
}

/** Shown when a relay (v2) link is used and ReleasePolicy.relayPairing is off. */
export const RELAY_PAIRING_OFF_MESSAGE = `This link is for a relay connection, which ${APP_DISPLAY_NAME} does not use. On your computer, run the ${APP_DISPLAY_NAME} setup again and scan the new code: it connects through Tailscale.`;

/**
 * Tailscale endpoint: a MagicDNS name (*.ts.net) or 100.64.0.0/10. Same rule as the server's
 * `isTailnetEndpoint` (packages/server/src/server/connection-offer.ts).
 */
export function isTailnetEndpoint(endpoint: string): boolean {
  const host = endpoint
    .trim()
    .replace(/^\[|\](:\d+)?$/g, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  if (host.endsWith(".ts.net")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/** Shown when a pairing code has no Tailscale address and ReleasePolicy.tailnetOnly is on. */
export const NO_TAILNET_MESSAGE = `Almost there! This code has no Tailscale address yet, and ${APP_DISPLAY_NAME} connects to your computer through Tailscale. Install Tailscale on your computer and on ${DEVICE_COPY.thisDevice}, sign in to both with the same account, then run the ${APP_DISPLAY_NAME} setup on your computer again for a fresh code.`;

/** Keeps only Tailscale endpoints (27 Oct: Tailscale only, no LAN). Throws when none. */
export function tailnetOnlyEndpoints(endpoints: readonly string[]): string[] {
  const kept = endpoints.filter(isTailnetEndpoint);
  if (kept.length === 0) throw new Error(NO_TAILNET_MESSAGE);
  return kept;
}

/** Shown under a failed pairing: the usual cause is Tailscale being off on one side. */
export const TAILSCALE_HELP = `Can't reach your computer? Tailscale is usually the reason, and it's quick to fix:
1. On ${DEVICE_COPY.thisDevice}, open the Tailscale app and check it says Connected.
2. On your computer, check Tailscale is running and signed in to the same account.
3. Try again. If it still fails, run \`${APP_LINK_SCHEME} doctor\` on your computer.`;
