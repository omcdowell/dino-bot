/**
 * Where paseo-apns keeps its files and what it reads from config.json.
 *
 * Nothing secret lives in config.json: the APNs key is referenced by path only and is read by
 * the sender at JWT-minting time (server/jwt.ts), never here.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export type ApnsEnvironment = "development" | "production";

/**
 * How this host reaches the phone when the app is closed.
 * - "apns": signs pushes with the app team's own .p8 key (only when the daemon owner signs the app).
 * - "local": no remote push at all. Alerts are refused with `push_off`; the Live Activity sync still
 *   answers the busy bots, and the app applies and polls them while it is open.
 * Without config.json the mode is "local"; a config.json without `mode` keeps "apns".
 */
export const PUSH_MODES = ["apns", "local"] as const;
export type PushMode = (typeof PUSH_MODES)[number];

export interface ApnsConfig {
  /** Absolute path of the .p8 token-auth key. Read only when a JWT is minted. */
  keyPath: string;
  keyId: string;
  teamId: string;
  /** Bundle id the app was built with, sent as apns-topic. */
  topic: string;
}

export interface Settings {
  dir: string;
  mode: PushMode;
  /** null until config.json names a key, key id, team and topic. */
  apns: ApnsConfig | null;
  /** Why apns is null, for the status endpoint. */
  configError: string | null;
  port: number;
  /** One push per window. Global unless perSender is set. */
  rateWindowMs: number;
  perSender: boolean;
  /** How long a minted JWT is reused. Apple: refresh at most every 20 min, tokens expire after 60. */
  jwtReuseMs: number;
  /** Paseo server id, added to every payload so a tap can route to the right host. */
  serverId: string | null;
}

export const DEFAULT_PORT = 6790;
export const DEFAULT_RATE_WINDOW_S = 600;
export const DEFAULT_JWT_REUSE_MIN = 40;
export const JWT_MIN_REUSE_MIN = 20;
export const JWT_MAX_REUSE_MIN = 50;

export const FILES = {
  config: "config.json",
  notifyToken: "notify-token",
  devices: "devices.json",
  log: "push-log.jsonl",
  liveActivities: "live-activities.json",
} as const;

export function defaultDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_APNS_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "paseo-apns");
}

const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const TOPIC_RE = /^[A-Za-z0-9.-]{1,155}$/;

function readServerId(env: NodeJS.ProcessEnv): string | null {
  try {
    const id = readFileSync(join(env.PASEO_HOME || join(homedir(), ".paseo"), "server-id"), "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Reads config.json (optional; sending stays off without it). Never throws. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, dir = defaultDir(env)): Settings {
  let raw: Record<string, unknown> = {};
  let configError: string | null = null;
  try {
    raw = JSON.parse(readFileSync(join(dir, FILES.config), "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not an object");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    configError = code === "ENOENT" ? "config.json missing" : `config.json unreadable (${code ?? "parse error"})`;
    raw = {};
  }

  const mode: PushMode = (PUSH_MODES as readonly unknown[]).includes(raw.mode)
    ? (raw.mode as PushMode)
    : configError === "config.json missing"
      ? "local"
      : "apns";
  let apns: ApnsConfig | null = null;
  if (!configError && mode === "apns") {
    const { keyPath, keyId, teamId, topic } = raw as Record<string, unknown>;
    if (typeof keyPath !== "string" || !keyPath.startsWith("/")) configError = "keyPath must be an absolute path";
    else if (typeof keyId !== "string" || !KEY_ID_RE.test(keyId)) configError = "keyId must be 10 characters";
    else if (typeof teamId !== "string" || !KEY_ID_RE.test(teamId)) configError = "teamId must be 10 characters";
    else if (typeof topic !== "string" || !TOPIC_RE.test(topic)) configError = "topic must be a bundle id";
    else apns = { keyPath, keyId, teamId, topic };
  }

  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const rate = (typeof raw.rateLimit === "object" && raw.rateLimit) || {};
  return {
    dir,
    mode,
    apns,
    configError,
    port: clamp(Math.trunc(num(raw.port, DEFAULT_PORT)), 1024, 65535),
    rateWindowMs: Math.max(0, num((rate as Record<string, unknown>).windowSeconds, DEFAULT_RATE_WINDOW_S)) * 1000,
    perSender: (rate as Record<string, unknown>).perSender === true,
    jwtReuseMs: clamp(num(raw.jwtReuseMinutes, DEFAULT_JWT_REUSE_MIN), JWT_MIN_REUSE_MIN, JWT_MAX_REUSE_MIN) * 60_000,
    serverId: typeof raw.serverId === "string" ? raw.serverId : readServerId(env),
  };
}

/** Creates the state dir (700) and the notify token (600) if missing; returns the token. */
export function ensureNotifyToken(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, FILES.notifyToken);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  chmodSync(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error(`${path} holds no usable token`);
  return token;
}
