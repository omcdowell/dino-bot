/**
 * Wires settings, registry, limiter, log, sender and endpoint together. index.server.ts starts one
 * of these; tests start their own with a fake APNs and a throwaway key.
 */
import { join } from "node:path";
import type { Server } from "node:http";
import { FILES, ensureNotifyToken, type Settings } from "./config.ts";
import { ProviderToken } from "./jwt.ts";
import { ApnsSender, Http2Transport, type Transport } from "./apns-client.ts";
import { DeviceStore, tokenTail } from "./devices.ts";
import { PushLog } from "./push-log.ts";
import { RateLimiter, GLOBAL_KEY } from "./rate-limit.ts";
import { notify, type NotifyInput } from "./notify.ts";
import { createEndpoint, listen } from "./endpoint.ts";
import { LiveActivityService, type SyncInput, type Timers } from "./live-activity.ts";
import type { ApnsEnvironment } from "./config.ts";

export interface ServiceOptions {
  settings: Settings;
  transport?: Transport;
  now?: () => number;
  readKey?: (path: string) => Buffer;
  retryDelayMs?: () => number;
  /** Live Activity timers (tests pass a manual clock). */
  timers?: Timers;
}

export class ApnsService {
  readonly devices: DeviceStore;
  readonly log: PushLog;
  readonly limiter: RateLimiter;
  readonly sender: ApnsSender | null;
  readonly liveActivity: LiveActivityService;
  private readonly transport: Transport;
  private readonly now: () => number;
  private server: Server | null = null;

  constructor(readonly options: ServiceOptions) {
    const { settings } = options;
    this.now = options.now ?? Date.now;
    this.devices = new DeviceStore(join(settings.dir, FILES.devices), this.now);
    this.log = new PushLog(join(settings.dir, FILES.log), this.now);
    this.limiter = new RateLimiter(settings.rateWindowMs, settings.perSender);
    this.limiter.restore(this.log.tail());
    this.transport = options.transport ?? new Http2Transport();
    this.sender = settings.apns
      ? new ApnsSender({
          transport: this.transport,
          topic: settings.apns.topic,
          now: this.now,
          retryDelayMs: options.retryDelayMs,
          token: new ProviderToken({
            keyPath: settings.apns.keyPath,
            keyId: settings.apns.keyId,
            teamId: settings.apns.teamId,
            reuseMs: settings.jwtReuseMs,
            now: this.now,
            readKey: options.readKey,
          }),
        })
      : null;
    this.liveActivity = new LiveActivityService({
      storePath: join(settings.dir, FILES.liveActivities),
      topic: settings.apns ? `${settings.apns.topic}.push-type.liveactivity` : null,
      sender: this.sender,
      log: this.log,
      now: this.now,
      timers: options.timers,
    });
  }

  notify(input: NotifyInput) {
    return notify(input, {
      settings: this.options.settings,
      devices: this.devices,
      limiter: this.limiter,
      log: this.log,
      sender: this.sender,
      now: this.now,
    });
  }

  /** `sender`: answer nextSlotAt for that sender's slot (per-sender mode); without it, the global slot. */
  status(sender?: string) {
    const { settings } = this.options;
    const topic = settings.apns?.topic ?? null;
    const devices = this.devices.list().filter((d) => d.topic === topic);
    const perSenderKey = settings.perSender ? (sender ?? null) : GLOBAL_KEY;
    const check = perSenderKey === null ? ({ ok: true } as const) : this.limiter.check(perSenderKey, this.now());
    return {
      mode: settings.mode,
      // Whether the phone can be reached while the app is closed (alerts and Live Activity pushes).
      pushes: this.sender !== null,
      configured: !!settings.apns,
      configError: settings.configError,
      topic,
      devices: devices.length,
      environments: [...new Set(devices.map((d) => d.environment))],
      rateWindowSeconds: settings.rateWindowMs / 1000,
      perSender: settings.perSender,
      // Per-sender mode: only for the sender asked about (?sender=); null without one.
      nextSlotAt: !check.ok ? new Date(check.retryAt).toISOString() : null,
      ...(settings.perSender && sender ? { sender } : {}),
      liveActivity: this.liveActivity.status(),
    };
  }

  register(input: { token: string; environment: ApnsEnvironment; topic: string; name?: string | null }) {
    const topic = this.options.settings.apns?.topic;
    if (topic && input.topic !== topic) {
      this.log.append("refused", { code: "wrong_topic", topic: input.topic, device: tokenTail(input.token) });
      return { ok: false, devices: this.devices.list().length, reason: `this add-on sends for ${topic}, not ${input.topic}` };
    }
    const added = this.devices.register(input);
    if (added) this.log.append("registered", { device: tokenTail(input.token), environment: input.environment, topic: input.topic, name: input.name ?? null });
    return { ok: true, devices: this.devices.list().length, reason: null };
  }

  /** The app's Live Activity sync RPC; refused for a foreign topic like register. */
  liveActivitySync(input: SyncInput & { topic: string }) {
    const topic = this.options.settings.apns?.topic;
    // pushes: false tells the app nothing updates the activity while it is closed, so it polls this
    // sync while open (local mode, or apns mode without a usable config).
    const pushes = this.sender !== null;
    if (topic && input.topic !== topic) return { ok: false, reason: `this add-on sends for ${topic}, not ${input.topic}`, state: null, staleDate: null, pushes };
    const out = this.liveActivity.sync({
      installId: input.installId,
      environment: input.environment,
      startToken: input.startToken?.toLowerCase() ?? null,
      activities: input.activities.map((a) => ({ id: a.id, token: a.token?.toLowerCase() ?? null })),
      appearance: input.appearance ?? null,
      dinoLayers: input.dinoLayers ?? null,
    });
    return { ok: true, reason: null, ...out, pushes };
  }

  revoke(token: string) {
    const removed = this.devices.remove(token);
    if (removed) this.log.append("revoked", { device: tokenTail(token) });
    return { ok: true, removed };
  }

  /** Starts the 127.0.0.1 endpoint; returns the bound port. */
  async start(): Promise<number> {
    const token = ensureNotifyToken(this.options.settings.dir);
    this.server = createEndpoint(token, {
      notify: (i) => this.notify(i),
      status: (sender) => this.status(sender),
      liveActivity: (bots) => this.liveActivity.setBots(bots),
    });
    return listen(this.server, this.options.settings.port);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.liveActivity.stop();
    this.transport.close();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }
}
