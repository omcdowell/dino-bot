/**
 * Host side of onboarding on the phone (shared/onboarding-rpc.ts). pi is the infrastructure: the
 * sign-in, readiness check, model list and effort levels all come from pi through DinoBot's
 * installer module (DINOBOT_HOME/app/installer/lib/phone-signin.mjs). This file only applies the
 * user's choice to what the plugin owns: the host settings (`models`), every bot that still
 * follows the host default, and pi's own defaults in DinoBot's pi dir (herdr workers run `pi`).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setDefaultChatModel } from "./bots";
import { hostProfileConfig } from "./manage";
import { MODEL_ROLES, parseModelPick, settingsPath, type BotsSettings, type HostModels, type ModelPick } from "./settings";

type Installer = {
  options(): Promise<{ options: unknown[]; signedIn: string[] }>;
  start(input: { optionId: string; confirmed: boolean }): Promise<unknown>;
  submit(input: { sessionId: string; text: string }): unknown;
  status(input: { sessionId: string }): unknown;
  cancel(input: { sessionId: string }): unknown;
  models(input?: { refresh?: boolean }): Promise<{
    providers: string[];
    subscription: string | null;
    models: Array<{ provider: string; id: string; name: string; levels: string[] }>;
    suggested: HostModels;
  }>;
  recordModels(models: HostModels): void;
  importScan(): Promise<Record<string, unknown>>;
  importStart(): Promise<{ ok: boolean; error?: string }>;
};

const OPTCHAT = "optchat";
const PROFILE_FILE = ".optchat-profile";
const META_FILE = ".bot.json";

async function atomicWrite(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode });
  await rename(tmp, path);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class Onboarding {
  private installer: Promise<Installer | null> | null = null;
  constructor(
    private readonly settings: BotsSettings,
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** DinoBot's onboarding module, or null on a host without DinoBot's installer. */
  host(): Promise<Installer | null> {
    if (!this.installer) {
      const home = this.env.DINOBOT_HOME;
      const file = home ? join(home, "app", "installer", "lib", "phone-signin.mjs") : "";
      this.installer =
        file && existsSync(file)
          ? import(pathToFileURL(file).href).then((m: { createOnboarding: (env: NodeJS.ProcessEnv) => Installer }) => m.createOnboarding(this.env))
          : Promise.resolve(null);
    }
    return this.installer;
  }

  async need(): Promise<Installer> {
    const h = await this.host();
    if (!h) throw new Error("Sign-in from the phone needs DinoBot's host setup (DINOBOT_HOME).");
    return h;
  }

  async options() {
    const h = await this.host();
    if (!h) return { available: false, options: [], signedIn: [], error: null };
    try {
      const r = await h.options();
      return { available: true, options: r.options as never, signedIn: r.signedIn, error: null };
    } catch (e) {
      return { available: true, options: [], signedIn: [], error: (e as Error).message };
    }
  }

  async models(refresh: boolean) {
    const current = this.settings.models;
    const h = await this.host();
    if (!h) return { available: false, providers: [], subscription: null, models: [], suggested: { bots: null, compaction: null, workers: null }, current, error: null };
    try {
      const r = await h.models({ refresh });
      return { available: true, ...r, current, error: null };
    } catch (e) {
      return { available: true, providers: [], subscription: null, models: [], suggested: { bots: null, compaction: null, workers: null }, current, error: (e as Error).message };
    }
  }

  async importScan(): Promise<{ signIn?: string; estimate?: Record<string, unknown> }> {
    const h = await this.host();
    if (!h) return {};
    const s = await h.importScan().catch(() => null);
    if (!s || s.ok !== true) return {};
    return { signIn: typeof s.subscription === "string" ? s.subscription : undefined, estimate: (s.estimate as Record<string, unknown>) ?? undefined };
  }

  /**
   * The "Choose models" answer. Each pick is checked against pi's live list (when the host has
   * DinoBot's module), then written to: settings `models` (+ `defaultModel`), every bot that
   * follows the host default (no own `chat` in .bot.json, or one set by setup), those bots'
   * OptChat config.json, and pi's defaults in DinoBot's pi dir for herdr workers.
   */
  async apply(input: { models?: Partial<Record<(typeof MODEL_ROLES)[number], ModelPick | null>>; defaultBotModel?: string | null; import?: { days: number | null; includeScratch: boolean } | null }) {
    const applied: string[] = [];
    const h = await this.host();
    let models: HostModels | null = null;
    if (input.models) {
      models = { bots: parseModelPick(input.models.bots), compaction: parseModelPick(input.models.compaction), workers: parseModelPick(input.models.workers) };
    } else if (input.defaultBotModel) {
      const [provider, ...rest] = input.defaultBotModel.split("/");
      models = { ...this.settings.models, bots: parseModelPick({ provider, model: rest.join("/"), thinking: null }) };
    }
    if (models) {
      if (h) {
        const live = await h.models();
        for (const role of MODEL_ROLES) {
          const pick = models[role];
          if (!pick) continue;
          const m = live.models.find((x) => x.provider === pick.provider && x.id === pick.model);
          if (!m) throw new Error(`pi does not offer ${pick.provider}/${pick.model} with your sign-in.`);
          if (pick.thinking && !m.levels.includes(pick.thinking)) throw new Error(`${pick.model} has no "${pick.thinking}" effort (it has: ${m.levels.join(", ") || "none"}).`);
        }
      }
      await this.writeSettings(models);
      applied.push("settings");
      applied.push(...(await this.applyToBots(models)));
      if (await this.writePiDefaults(models.workers)) applied.push("pi defaults (workers)");
      h?.recordModels(models);
    }
    if (input.import && h) {
      const r = await h.importStart();
      applied.push(r.ok ? "import started" : `import: ${r.error ?? "failed"}`);
    }
    return { ok: true, applied, error: null };
  }

  private async writeSettings(models: HostModels) {
    const path = settingsPath({ ...this.env, PASEO_BOTS_ROOT: this.root });
    const raw = (await readJson(path)) ?? {};
    raw.models = models;
    if (models.bots) raw.defaultModel = `${models.bots.provider}/${models.bots.model}`;
    await atomicWrite(path, `${JSON.stringify(raw, null, 2)}\n`, 0o644);
    this.settings.models = models;
    if (models.bots) this.settings.defaultModel = `${models.bots.provider}/${models.bots.model}`;
    setDefaultChatModel(models.bots ? `${models.bots.provider}/${models.bots.model}` : this.settings.defaultModel, models.bots?.thinking ?? null);
  }

  /** Bots that follow the host default: no `chat` of their own, or one written by setup. */
  private async applyToBots(models: HostModels): Promise<string[]> {
    const out: string[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(this.root);
    } catch {
      return out;
    }
    const optchatHome = this.env.OPTCHAT_HOME ?? join(this.env.HOME ?? "", ".optchat");
    for (const id of entries) {
      const dir = join(this.root, id);
      if (!existsSync(join(dir, PROFILE_FILE))) continue;
      const meta = (await readJson(join(dir, META_FILE))) ?? {};
      const chat = meta.chat as { setup?: boolean } | undefined;
      if (chat && !chat.setup) continue; // the user picked this bot's model: keep it
      if (models.bots) {
        meta.chat = { provider: `${OPTCHAT}/${models.bots.provider}/${models.bots.model}`, ...(models.bots.thinking ? { thinkingOptionId: models.bots.thinking } : {}), setup: true };
        await atomicWrite(join(dir, META_FILE), `${JSON.stringify(meta)}\n`, 0o664);
      }
      const profileName = readFileSync(join(dir, PROFILE_FILE), "utf8").trim() || id;
      const cfgPath = join(optchatHome, "profiles", profileName, "config.json");
      const cfg = await readJson(cfgPath);
      const host = hostProfileConfig(models);
      if (host && (!cfg || cfg.setup === true)) {
        await atomicWrite(cfgPath, `${JSON.stringify({ ...(cfg ?? {}), ...host, setup: true }, null, 2)}\n`, 0o600);
      }
      out.push(`bot ${id}`);
    }
    return out;
  }

  /** pi's defaults in DinoBot's pi dir: what a plain `pi` (a herdr worker) runs on. */
  private async writePiDefaults(workers: ModelPick | null): Promise<boolean> {
    const dir = this.env.PI_CODING_AGENT_DIR;
    if (!dir || !workers) return false;
    const path = join(dir, "settings.json");
    const s = (await readJson(path)) ?? {};
    s.defaultProvider = workers.provider;
    s.defaultModel = workers.model;
    if (workers.thinking) s.defaultThinkingLevel = workers.thinking;
    else delete s.defaultThinkingLevel;
    await atomicWrite(path, `${JSON.stringify(s, null, 2)}\n`, 0o600);
    return true;
  }
}
