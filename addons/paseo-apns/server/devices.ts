/**
 * Device-token registry: `devices.json` (600) in the state dir.
 *
 * The app registers on every connect and when iOS rotates its token. There is no lease: a phone
 * left closed for days must still get alerts. Stale tokens leave when APNs answers 410
 * Unregistered or 400 BadDeviceToken, or when the app revokes them.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApnsEnvironment } from "./config.ts";

export interface Device {
  token: string;
  environment: ApnsEnvironment;
  topic: string;
  name: string | null;
  registeredAt: string;
  lastSeenAt: string;
}

export const MAX_DEVICES = 20;
export const DEVICE_TOKEN_RE = /^[0-9a-f]{64,200}$/;

/** Last 8 hex chars: enough to tell devices apart in logs without writing whole tokens. */
export const tokenTail = (token: string) => `…${token.slice(-8)}`;

export class DeviceStore {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Device[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(parsed?.devices) ? (parsed.devices as Device[]).filter((d) => DEVICE_TOKEN_RE.test(d?.token ?? "")) : [];
    } catch {
      return [];
    }
  }

  private write(devices: Device[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Adds or refreshes a device; returns whether it was new. */
  register(input: { token: string; environment: ApnsEnvironment; topic: string; name?: string | null }): boolean {
    const token = input.token.toLowerCase();
    if (!DEVICE_TOKEN_RE.test(token)) throw new Error("not an APNs device token");
    const at = new Date(this.now()).toISOString();
    const devices = this.list();
    const held = devices.find((d) => d.token === token);
    if (held) {
      held.environment = input.environment;
      held.topic = input.topic;
      held.name = input.name ?? held.name;
      held.lastSeenAt = at;
    } else {
      devices.push({ token, environment: input.environment, topic: input.topic, name: input.name ?? null, registeredAt: at, lastSeenAt: at });
    }
    devices.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    this.write(devices.slice(0, MAX_DEVICES));
    return !held;
  }

  remove(token: string): boolean {
    const devices = this.list();
    const kept = devices.filter((d) => d.token !== token.toLowerCase());
    if (kept.length === devices.length) return false;
    this.write(kept);
    return true;
  }
}
