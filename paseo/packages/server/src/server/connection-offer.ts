import os from "node:os";

import {
  ConnectionOfferV2Schema,
  DirectConnectionOfferSchema,
  type ConnectionOffer,
  type DirectConnectionOffer,
} from "@getpaseo/protocol/connection-offer";

interface BuildOfferEndpointsArgs {
  listenHost: string;
  port: number;
}

export function buildOfferEndpoints({ listenHost, port }: BuildOfferEndpointsArgs): string[] {
  const endpoints: string[] = [];

  const isLoopbackHost = listenHost === "127.0.0.1" || listenHost === "localhost";
  const isWildcardHost = listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]";

  if (isWildcardHost) {
    const lanIp = getPrimaryLanIp();
    if (lanIp) {
      endpoints.push(`${lanIp}:${port}`);
    }
  } else if (!isLoopbackHost) {
    endpoints.push(`${listenHost}:${port}`);
  }

  endpoints.push(`localhost:${port}`);

  return dedupePreserveOrder(endpoints);
}

/** Tailnet (CGNAT 100.64.0.0/10) IPv4 address of this machine, if Tailscale is up. */
export function getTailnetIp(
  nets: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  for (const name of Object.keys(nets).sort()) {
    for (const addr of nets[name] ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const [a, b] = addr.address.split(".").map(Number);
      if (a === 100 && b !== undefined && b >= 64 && b <= 127) return addr.address;
    }
  }
  return null;
}

/**
 * Endpoints for a direct (v3) pairing offer, best first (rel-bench §3.3): names the installer
 * knows (`PASEO_DIRECT_ENDPOINTS`, e.g. the MagicDNS name), the tailnet IP, `<host>.local`, the
 * LAN IP, then localhost. A daemon bound to one address offers that address (plus extras) only.
 */
export function buildDirectOfferEndpoints(args: {
  listenHost: string;
  port: number;
  extra?: string[];
  hostname?: string;
  tailnetIp?: string | null;
  lanIp?: string | null;
}): string[] {
  const { listenHost, port } = args;
  const endpoints: string[] = [...(args.extra ?? [])];
  const isLoopbackHost = listenHost === "127.0.0.1" || listenHost === "localhost";
  const isWildcardHost = listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]";
  if (isWildcardHost) {
    const tailnetIp = args.tailnetIp === undefined ? getTailnetIp() : args.tailnetIp;
    if (tailnetIp) endpoints.push(`${tailnetIp}:${port}`);
    const host = (args.hostname ?? os.hostname()).split(".")[0];
    if (host) endpoints.push(`${host}.local:${port}`);
    const lanIp = args.lanIp === undefined ? getPrimaryLanIp() : args.lanIp;
    if (lanIp && lanIp !== tailnetIp) endpoints.push(`${lanIp}:${port}`);
  } else if (!isLoopbackHost) {
    endpoints.push(`${listenHost}:${port}`);
  }
  endpoints.push(`localhost:${port}`);
  return dedupePreserveOrder(endpoints);
}

/** True for a Tailscale endpoint: a MagicDNS name (*.ts.net) or an address in 100.64.0.0/10. */
export function isTailnetEndpoint(endpoint: string): boolean {
  const host = endpoint
    .trim()
    .replace(/^\[|\](:\d+)?$/g, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  if (host.endsWith(".ts.net")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export function createDirectConnectionOffer(args: {
  serverId: string;
  daemonPublicKeyB64: string;
  endpoints: string[];
  password?: string;
}): DirectConnectionOffer {
  return DirectConnectionOfferSchema.parse({
    v: 3,
    serverId: args.serverId,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    endpoints: args.endpoints,
    ...(args.password ? { password: args.password } : {}),
  });
}

export async function createConnectionOfferV2(args: {
  serverId: string;
  daemonPublicKeyB64: string;
  relay: { endpoint: string; useTls?: boolean };
  minimumSecurityMode?: "protected";
}): Promise<ConnectionOffer> {
  return ConnectionOfferV2Schema.parse({
    v: 2,
    serverId: args.serverId,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    relay: args.relay,
    ...(args.minimumSecurityMode ? { minimumSecurityMode: args.minimumSecurityMode } : {}),
  });
}

export function encodeOfferToFragmentUrl(args: {
  offer: ConnectionOffer | DirectConnectionOffer;
  appBaseUrl: string;
}): string {
  const json = JSON.stringify(args.offer);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `${args.appBaseUrl.replace(/\/$/, "")}/#offer=${encoded}`;
}

function getPrimaryLanIp(): string | null {
  const tailnetIp = getTailnetIp();
  const override = process.env.PASEO_PRIMARY_LAN_IP?.trim();
  if (override) return override;

  const nets = os.networkInterfaces();
  const names = Object.keys(nets).sort();

  for (const name of names) {
    const addrs = nets[name] ?? [];
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal && addr.address !== tailnetIp) {
        return addr.address;
      }
    }
  }
  return null;
}

function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
