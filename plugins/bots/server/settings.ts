/**
 * Host settings for the bots plugin, its CLIs (bot-dm, bot-worker) and the OptChat bots it starts.
 *
 * One JSON file, `<bots root>/.settings.json` (or PASEO_BOTS_SETTINGS). Every key is optional; a
 * missing or unreadable file gives the public defaults below. Nothing personal is hard-wired: the
 * user's name, the escalation bot, the default bot model, the herdr instance and private add-ons
 * all come from here.
 *
 *   {
 *     "user": { "name": "Sam", "aliases": ["sam"] },
 *     "escalation": "coordinator",          // bot that gets `escalate` DMs; null = none
 *     "defaultModel": "anthropic/claude-sonnet-4-5", // OptChat model for a bot's first chat (older key)
 *     "models": {                           // setup's "Choose models" step (setup.apply); null = none
 *       "bots":       { "provider": "openai-codex", "model": "gpt-6-sol", "thinking": "medium" },
 *       "compaction": { "provider": "openai-codex", "model": "gpt-5.6-terra", "thinking": "low" },
 *       "workers":    { "provider": "openai-codex", "model": "gpt-6-sol", "thinking": "high" }
 *     },
 *     "herdr": { "session": "paseo-bots" }, // own herdr instance; null = the user's default server
 *     "rooms": { "fullTools": false },      // group chats: false = read-only lookups (A), true = main chat tools (B)
 *     "extensions": ["/path/to/private-addon/index.ts"],
 *     "addons": { "<add-on>": { "url": "http://…", "consumer": "…", "label": "…" } } // add-on config
 *   }
 *
 * Env: PASEO_BOTS_SETTINGS (file path), PASEO_BOTS_ROOT (bots root), BOT_DM_FC (escalation bot,
 * read by bot-dm). The public plugin reads nothing under `addons`; each add-on reads its own key
 * from `api.settings.addons` (server/extensions.ts). See docs/settings.md.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { USER, setUserAliases } from "../shared/party.ts";

export { USER };
/** Herdr session the plugin starts for workers when the settings name none. */
export const DEFAULT_HERDR_SESSION = "paseo-bots";

/** A pi model with its effort (thinking level; null when the model has none). */
export type ModelPick = { provider: string; model: string; thinking: string | null };
/** The three roles setup asks about (27 Oct): bot chats, OptChat compaction, herdr workers. */
export type HostModels = { bots: ModelPick | null; compaction: ModelPick | null; workers: ModelPick | null };
export const MODEL_ROLES = ["bots", "compaction", "workers"] as const;

export type BotsSettings = {
  user: {
    /** How bots and prompts name the user ("not from Sam"). */
    name: string;
    /** Extra party ids that mean the user: `bot-dm <alias>` and old ledger lines. Lower case. */
    aliases: string[];
  };
  /** Bot that gets escalations (bot-dm `escalate`, OptChat memory). null: no escalation target. */
  escalation: string | null;
  /** OptChat model (without the `optchat/` prefix) for a bot's first chat. null: OptChat's default. */
  defaultModel: string | null;
  /** Models and effort per role, from setup (no hard-coded defaults: null until chosen). */
  models: HostModels;
  /** Herdr named session for workers. null: the user's own default herdr server (opt-in). */
  herdr: { session: string | null };
  /**
   * Group chats (27 Oct: "A for groupchats with a toggle in settings to go to B"). fullTools false (A):
   * room sessions talk and look things up, read-only. true (B): the same tools as a bot's main chat. pi-optchat reads
   * this key itself on every room turn (OPTCHAT_ROOM_SETTINGS), so a change needs no reload.
   */
  rooms: { fullTools: boolean };
  /** Absolute module paths of add-ons loaded by the plugin server (server/extensions.ts). */
  extensions: string[];
  /** Free-form config owned by add-ons, by key (e.g. a usage add-on's source URL). */
  addons: Record<string, unknown>;
};

export const DEFAULT_SETTINGS: BotsSettings = {
  user: { name: "the user", aliases: [] },
  escalation: null,
  defaultModel: null,
  models: { bots: null, compaction: null, workers: null },
  herdr: { session: DEFAULT_HERDR_SESSION },
  rooms: { fullTools: false },
  extensions: [],
  addons: {},
};

const PARTY_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const THINKING_RE = /^(off|minimal|low|medium|high|xhigh|max)$/;

export function parseModelPick(value: unknown): ModelPick | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const provider = str(v.provider);
  const model = str(v.model);
  if (!provider || !model) return null;
  const thinking = typeof v.thinking === "string" && THINKING_RE.test(v.thinking) ? v.thinking : null;
  return { provider, model, thinking };
}

/** "provider/model" (an OptChat / pi model id), with ":thinking" when asked (pi --model syntax). */
export function modelRef(pick: ModelPick, withThinking = false): string {
  return `${pick.provider}/${pick.model}${withThinking && pick.thinking ? `:${pick.thinking}` : ""}`;
}

/** Parses a settings object; bad values fall back to the defaults one key at a time. */
export function parseSettings(raw: unknown, baseDir = process.cwd()): BotsSettings {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const user = obj.user && typeof obj.user === "object" ? (obj.user as Record<string, unknown>) : {};
  const aliases = Array.isArray(user.aliases)
    ? [...new Set(user.aliases.flatMap((a) => (typeof a === "string" && PARTY_RE.test(a.toLowerCase()) ? [a.toLowerCase()] : [])))]
        .filter((a) => a !== USER)
    : [];
  const escalation =
    obj.escalation === null ? null : (str(obj.escalation) && PARTY_RE.test(String(obj.escalation)) ? String(obj.escalation) : null);
  const herdr = obj.herdr && typeof obj.herdr === "object" ? (obj.herdr as Record<string, unknown>) : {};
  const session =
    herdr.session === null ? null : str(herdr.session) && SESSION_RE.test(String(herdr.session)) ? String(herdr.session) : DEFAULT_HERDR_SESSION;
  const extensions = Array.isArray(obj.extensions)
    ? obj.extensions.flatMap((p) => (str(p) ? [isAbsolute(String(p)) ? String(p) : resolve(baseDir, String(p))] : []))
    : [];
  const models = obj.models && typeof obj.models === "object" ? (obj.models as Record<string, unknown>) : {};
  const rooms = obj.rooms && typeof obj.rooms === "object" ? (obj.rooms as Record<string, unknown>) : {};
  return {
    user: { name: str(user.name) ?? DEFAULT_SETTINGS.user.name, aliases },
    escalation,
    defaultModel: str(obj.defaultModel),
    models: { bots: parseModelPick(models.bots), compaction: parseModelPick(models.compaction), workers: parseModelPick(models.workers) },
    herdr: { session },
    rooms: { fullTools: rooms.fullTools === true },
    extensions,
    addons: obj.addons && typeof obj.addons === "object" && !Array.isArray(obj.addons) ? { ...(obj.addons as Record<string, unknown>) } : {},
  };
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_BOTS_SETTINGS) return env.PASEO_BOTS_SETTINGS;
  return join(env.PASEO_BOTS_ROOT ?? join(homedir(), "bots"), ".settings.json");
}

/** Settings for a given bots root (PASEO_BOTS_SETTINGS still wins), e.g. BotFiles' root. */
export function readSettingsAt(root: string, env: NodeJS.ProcessEnv = process.env): BotsSettings {
  return readSettings({ ...env, PASEO_BOTS_ROOT: root });
}

/** Reads the settings file now (no cache: CLIs are short-lived, the plugin reads once at start). */
export function readSettings(env: NodeJS.ProcessEnv = process.env): BotsSettings {
  const path = settingsPath(env);
  if (!existsSync(path)) return parseSettings({});
  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")), dirname(path));
  } catch {
    return parseSettings({});
  }
}

/**
 * Sets `rooms.fullTools` in the settings file for `root` (PASEO_BOTS_SETTINGS still wins), keeping every other key
 * as written. Atomic (temp file + rename). A file that is not a JSON object is refused rather than overwritten.
 */
export function writeRoomFullTools(root: string, fullTools: boolean, env: NodeJS.ProcessEnv = process.env): { fullTools: boolean } {
  const path = settingsPath({ ...env, PASEO_BOTS_ROOT: root });
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; not changed.`);
    raw = parsed as Record<string, unknown>;
  }
  const rooms = raw.rooms && typeof raw.rooms === "object" && !Array.isArray(raw.rooms) ? (raw.rooms as Record<string, unknown>) : {};
  raw.rooms = { ...rooms, fullTools };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
  return { fullTools };
}

/** Reads the settings and registers the user's aliases for party parsing (shared/party.ts). */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): BotsSettings {
  const settings = readSettings(env);
  setUserAliases(settings.user.aliases);
  return settings;
}

/**
 * Env given to OptChat bots (and room agents) so their prompts and tools follow the settings.
 * pi-optchat reads BOTS_USER_NAME / BOTS_USER_ALIASES / BOTS_ESCALATE_TO; bot-dm reads the settings file itself.
 */
export function botEnv(settings: BotsSettings): Record<string, string> {
  return {
    BOTS_USER_NAME: settings.user.name,
    BOTS_USER_ALIASES: settings.user.aliases.join(","),
    BOTS_ESCALATE_TO: settings.escalation ?? "",
    // Herdr workers: the model and effort chosen in setup, as pi --model "provider/model:thinking".
    // DinoBot's pi settings.json carries the same as pi's defaults, so a plain `pi` also uses them.
    BOTS_WORKER_MODEL: settings.models.workers ? modelRef(settings.models.workers, true) : "",
  };
}
