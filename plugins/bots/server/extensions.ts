/**
 * Add-ons: private or optional code the public plugin does not contain, loaded from the
 * `extensions` setting (absolute module paths, server/settings.ts). An add-on's default export is
 * called once at plugin start with the API below; it may return a cleanup function.
 *
 * What an add-on can do:
 *   - registerUsageSource: a Paseo usage source (Settings → Usage), e.g. a proxy's per-user share;
 *   - setQuotaReader: the usage behind the rate-limit card and the Live Activity weekly gate;
 *   - onWorkers: see every workers read of the bots home (e.g. a stall watcher that DMs bots);
 *   - server: the plugin's PluginServerContext (extra RPCs, hooks);
 *   - botDmSender: send system DMs with bot-dm.
 *
 * A failing add-on is logged and skipped; the plugin runs without it.
 *
 * Loading is synchronous (require): Paseo reads a plugin's usage sources as soon as its setup
 * function returns. The daemon's Node (22.18+/24) strips the types of a `.ts` add-on itself, so an
 * add-on uses erasable TypeScript only, `.ts` import extensions, and no packages: it gets `zod`
 * from the API, so its usage source's input schema is the plugin's own zod.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { UsageReport, UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import type { BotsSettings } from "./settings";
import { botDmSender, ulid } from "./bot-dm-send";
import { tailLines } from "./tail";
import { appendJsonl, stateRoot, type BotWorkers } from "./workers";
import { NO_QUOTA, quotaFromReport, type QuotaWindows } from "./quota";

export interface BotsExtensionApi {
  settings: BotsSettings;
  env: NodeJS.ProcessEnv;
  server: PluginServerContext;
  registerUsageSource(source: UsageSourceRegistration): void;
  /** One reader for the whole host; a later call replaces an earlier one. */
  setQuotaReader(read: () => Promise<UsageReport>): void;
  onWorkers(listener: (bots: BotWorkers[]) => void): void;
  botDmSender: typeof botDmSender;
  zod: typeof z;
  /** Small file helpers, so an add-on needs no imports from this plugin. */
  helpers: {
    tailLines: typeof tailLines;
    appendJsonl: typeof appendJsonl;
    stateRoot: typeof stateRoot;
    ulid: typeof ulid;
    quotaFromReport: typeof quotaFromReport;
  };
  log(message: string): void;
}

export type BotsExtension = (api: BotsExtensionApi) => void | (() => void) | Promise<void | (() => void)>;

type Importer = (path: string) => { default?: unknown };

const defaultImporter: Importer = (path) => createRequire(join(process.cwd(), "paseo-bots-addons.js"))(path) as { default?: unknown };

export interface ExtensionsDeps {
  settings: BotsSettings;
  server: PluginServerContext;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  importer?: Importer;
}

export class Extensions {
  private quotaReader: (() => Promise<UsageReport>) | null = null;
  private readonly workerListeners: Array<(bots: BotWorkers[]) => void> = [];
  private readonly cleanups: Array<() => void> = [];
  readonly loaded: string[] = [];

  private readonly deps: ExtensionsDeps;

  constructor(deps: ExtensionsDeps) {
    this.deps = deps;
  }

  /** Loads every add-on in the settings, in order. Never throws. */
  load(): void {
    const log = this.deps.log ?? ((message: string) => console.warn(`[bots] ${message}`));
    const importer = this.deps.importer ?? defaultImporter;
    for (const path of this.deps.settings.extensions) {
      try {
        const mod = importer(path);
        if (typeof mod.default !== "function") throw new Error("no default export function");
        const result = (mod.default as BotsExtension)(this.api(path, log));
        if (typeof result === "function") this.cleanups.push(result);
        else if (result && typeof (result as Promise<unknown>).then === "function") {
          void (result as Promise<void | (() => void)>).then(
            (cleanup) => typeof cleanup === "function" && this.cleanups.push(cleanup),
            (error: unknown) => log(`add-on ${path} failed: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
        this.loaded.push(path);
      } catch (error) {
        log(`add-on ${path} not loaded: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private api(path: string, log: (message: string) => void): BotsExtensionApi {
    const { server, settings } = this.deps;
    return {
      settings,
      env: this.deps.env ?? process.env,
      server,
      registerUsageSource: (source) => server.registerUsageSource(source),
      setQuotaReader: (read) => {
        this.quotaReader = read;
      },
      onWorkers: (listener) => {
        this.workerListeners.push(listener);
      },
      botDmSender,
      zod: z,
      helpers: { tailLines, appendJsonl, stateRoot, ulid, quotaFromReport },
      log: (message) => log(`${path}: ${message}`),
    };
  }

  hasQuota(): boolean {
    return this.quotaReader !== null;
  }

  /** The add-on's usage report; throws when there is no reader (callers treat it as "unknown"). */
  async report(): Promise<UsageReport> {
    if (!this.quotaReader) throw new Error("no usage source");
    return this.quotaReader();
  }

  /** Windows for the rate-limit card: NO_QUOTA when no add-on reads usage. */
  async quota(): Promise<QuotaWindows> {
    if (!this.quotaReader) return NO_QUOTA;
    try {
      return quotaFromReport(await this.quotaReader());
    } catch (error) {
      return { windows: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  workers(bots: BotWorkers[]): void {
    for (const listener of this.workerListeners) {
      try {
        listener(bots);
      } catch {
        // an add-on's listener must not break the bots home
      }
    }
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
  }
}
