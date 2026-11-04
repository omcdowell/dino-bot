#!/usr/bin/env node
// Writes ~/.config/paseo-apns/config.json (600) and creates the notify token (600) if missing.
// The key is named by path only: this script never opens, reads or checks the key file.
//
//   node bin/setup.mjs --key-path /abs/AuthKey_<KEY_ID>.p8 --key-id XXXXXXXXXX --team-id YYYYYYYYYY \
//     --topic com.example.app [--port 6790] [--window-seconds 600] [--per-sender] [--force]
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    "key-path": { type: "string" },
    "key-id": { type: "string" },
    "team-id": { type: "string" },
    topic: { type: "string" },
    port: { type: "string" },
    "window-seconds": { type: "string" },
    "per-sender": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});
const fail = (m) => {
  process.stderr.write(`setup: ${m}\n`);
  process.exit(2);
};
if (!o["key-path"]?.startsWith("/")) fail("--key-path must be absolute");
if (!/^[A-Z0-9]{10}$/.test(o["key-id"] ?? "")) fail("--key-id must be 10 characters");
if (!/^[A-Z0-9]{10}$/.test(o["team-id"] ?? "")) fail("--team-id must be 10 characters");
if (!/^[A-Za-z0-9.-]+$/.test(o.topic ?? "")) fail("--topic must be the app's bundle id");

const dir = process.env.PASEO_APNS_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "paseo-apns");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const configPath = join(dir, "config.json");
if (existsSync(configPath) && !o.force) fail(`${configPath} exists; pass --force to replace it`);
const config = {
  keyPath: o["key-path"],
  keyId: o["key-id"],
  teamId: o["team-id"],
  topic: o.topic,
  port: o.port ? Number(o.port) : 6790,
  rateLimit: { windowSeconds: o["window-seconds"] ? Number(o["window-seconds"]) : 600, perSender: o["per-sender"] },
  jwtReuseMinutes: 40,
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(configPath, 0o600);

const tokenPath = join(dir, "notify-token");
if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
chmodSync(tokenPath, 0o600);
if (readFileSync(tokenPath, "utf8").trim().length < 32) fail(`${tokenPath} holds no usable token`);
process.stdout.write(`wrote ${configPath}; notify token at ${tokenPath}\n`);
