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
import type { CcModel } from "./cc/models";
import { CC_SETUP_PROVIDER, ccChatProvider, ccSetupModels, ccSuggested, isCcPick } from "./cc/setup-models";
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
  /** provider.* (lib/provider-install.mjs); absent in installers older than the RPCs. */
  providerList?(): Promise<{ packages: Array<{ source: string; bundled: boolean }>; providers: unknown[] }>;
  providerInstall?(input: { source: string; token?: string | null; name?: string | null }): unknown;
  providerInstallStatus?(input: { jobId: string }): unknown;
  providerRemove?(input: { source: string }): Promise<{ removed: string }>;
  /** engines.* (lib/engines.mjs); absent in installers older than the RPCs. */
  enginesStatus?(): Promise<{ pi: unknown; claudeCode: unknown }>;
  piSignOut?(input: { provider: string }): { removed: string };
  claudeLogout?(): Promise<{ ok: boolean }>;
};

type EngineInstaller = Required<Pick<Installer, "enginesStatus" | "piSignOut" | "claudeLogout">>;

/** Claude Code's side of "Choose models": its models and plan when it is signed in, else null. */
export type ClaudeCodeModels = (refresh: boolean) => Promise<{ models: readonly CcModel[]; plan: string | null } | null>;

type ProviderInstaller = Required<Pick<Installer, "providerList" | "providerInstall" | "providerInstallStatus" | "providerRemove">>;

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
    private readonly opts: { claudeCode?: ClaudeCodeModels } = {},
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

  /** The installer's provider.* side, or null (plain Paseo host, or an installer without it). */
  async providerHost(): Promise<ProviderInstaller | null> {
    const h = await this.host();
    return h?.providerList && h.providerInstall && h.providerInstallStatus && h.providerRemove ? (h as ProviderInstaller) : null;
  }

  async needProviders(): Promise<ProviderInstaller> {
    const h = await this.providerHost();
    if (!h) throw new Error("Adding providers from the app needs DinoBot's host setup (DINOBOT_HOME).");
    return h;
  }

  async providerList() {
    const h = await this.providerHost();
    if (!h) return { available: false, packages: [], providers: [], error: null };
    try {
      const r = await h.providerList();
      return { available: true, packages: r.packages, providers: r.providers as never, error: null };
    } catch (e) {
      return { available: true, packages: [], providers: [], error: (e as Error).message };
    }
  }

  /** The installer's engines.* side, or null (plain Paseo host, or an installer without it). */
  async engineHost(): Promise<EngineInstaller | null> {
    const h = await this.host();
    return h?.enginesStatus && h.piSignOut && h.claudeLogout ? (h as EngineInstaller) : null;
  }

  async needEngines(): Promise<EngineInstaller> {
    const h = await this.engineHost();
    if (!h) throw new Error("Sign-ins from the app need DinoBot's host setup (DINOBOT_HOME).");
    return h;
  }

  async engines() {
    const h = await this.engineHost();
    if (!h) return { available: false, pi: null, claudeCode: null, error: null };
    try {
      const r = await h.enginesStatus();
      return { available: true, pi: r.pi as never, claudeCode: r.claudeCode as never, error: null };
    } catch (e) {
      return { available: true, pi: null, claudeCode: null, error: (e as Error).message };
    }
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

  /**
   * "Choose models": pi's live list for its sign-ins plus, when Claude Code is signed in, Claude Code's models
   * (provider `claude-code`). A Claude-Code-only computer used to get an empty list here, and the app's "sign in"
   * sent the user back to a sign-in step that was already done (the v0.1.11 setup loop).
   */
  async models(refresh: boolean) {
    const current = this.settings.models;
    const none = { bots: null, compaction: null, workers: null };
    const h = await this.host();
    const [pi, cc] = await Promise.all([
      h
        ? h.models({ refresh }).then(
            (r) => ({ ok: true as const, r }),
            (e: Error) => ({ ok: false as const, error: e.message }),
          )
        : null,
      this.opts.claudeCode ? this.opts.claudeCode(refresh).catch(() => null) : Promise.resolve(null),
    ]);
    // No DinoBot onboarding module (a plain Paseo host, or one adopted by hand without DINOBOT_HOME): no pi list, but
    // Claude Code's models are still offered when it is signed in, so the screen is not a silent no-op.
    if (!pi && (!cc || !cc.models.length)) return { available: false, providers: [], subscription: null, models: [], suggested: none, current, error: null };
    const piPart = pi?.ok ? pi.r : { providers: [], subscription: null, models: [], suggested: none as HostModels };
    if (!cc || !cc.models.length) return { available: true, ...piPart, current, error: pi?.ok ? null : (pi?.error ?? null) };
    const ccSuggest = ccSuggested(cc.plan);
    const suggested = {} as HostModels;
    for (const role of MODEL_ROLES) suggested[role] = piPart.suggested[role] ?? ccSuggest[role];
    return {
      available: true,
      providers: [...piPart.providers, CC_SETUP_PROVIDER],
      subscription: piPart.subscription,
      models: [...piPart.models, ...ccSetupModels(cc.models)],
      suggested,
      current,
      // pi failing on a Claude-Code-only computer is no error the user can act on: Claude Code's models are here.
      error: null,
    };
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
      const live = await this.models(false);
      // Checked against the live list whenever there is one (with DinoBot's module, or Claude Code's alone).
      if (live.available) {
        if (live.error) throw new Error(live.error);
        for (const role of MODEL_ROLES) {
          const pick = models[role];
          if (!pick) continue;
          const m = live.models.find((x) => x.provider === pick.provider && x.id === pick.model);
          if (!m) throw new Error(`${isCcPick(pick) ? "Claude Code" : "pi"} does not offer ${pick.provider}/${pick.model} with your sign-in.`);
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
        meta.chat = { provider: ccChatProvider(models.bots), ...(models.bots.thinking ? { thinkingOptionId: models.bots.thinking } : {}), setup: true };
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
    // pi cannot run a Claude Code model: its defaults stay as they are (Claude Code workers get it from launch-cc.sh).
    if (!dir || !workers || isCcPick(workers)) return false;
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
