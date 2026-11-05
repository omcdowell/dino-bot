/**
 * Test helpers: a throwaway P-256 key in a temp dir (never the real key), a fake APNs over h2c,
 * and settings pointing at a temp state dir.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../server/config.ts";
import { Http2Transport } from "../server/apns-client.ts";

export const TOKEN_A = "a".repeat(64);
export const TOKEN_B = "b".repeat(64);

export function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-apns-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function throwawayKey(dir: string): { keyPath: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyPath = join(dir, "AuthKey_test-key.p8");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { keyPath, publicKey };
}

export function settings(dir: string, keyPath: string, over: Partial<Settings> = {}): Settings {
  return {
    dir,
    mode: "apns",
    apns: { keyPath, keyId: "TESTKEY001", teamId: "TESTTEAM01", topic: "com.example.app" },
    configError: null,
    port: 0,
    rateWindowMs: 600_000,
    perSender: false,
    jwtReuseMs: 40 * 60_000,
    serverId: "srv_test",
    ...over,
  };
}

export interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Reply per request: status and optional reason. Default 200. */
export type Responder = (req: Seen, n: number) => { status: number; reason?: string };

export async function fakeApns(t: { after(fn: () => Promise<void> | void): void }, responder: Responder = () => ({ status: 200 })) {
  const seen: Seen[] = [];
  const server: Http2Server = createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const req = { path: String(headers[":path"]), headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(req);
      const { status, reason } = responder(req, seen.length);
      stream.respond({ ":status": status, "apns-id": `id-${seen.length}`, "content-type": "application/json" });
      stream.end(reason ? JSON.stringify({ reason }) : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = new Http2Transport({ origins: { development: origin, production: origin }, timeoutMs: 2000 });
  t.after(async () => {
    transport.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { seen, transport, origin };
}

export function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c!, "base64url").toString()),
    input: `${h}.${c}`,
    signature: Buffer.from(s!, "base64url"),
  };
}
