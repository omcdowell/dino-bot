/**
 * Bot management on the host (build 31): the home state file (pins, archive) and bot files
 * (create, rename, avatar, AGENTS.md). Archive only hides: no folder is deleted, no timer stopped.
 *
 * Every write goes to a temp file and is renamed into place. The home state file is copied to
 * `.home.json.bak` before each write; .bot.json and avatar.png keep a `.bak` of the version they
 * replace.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AVATAR_UPLOAD_MAX,
  EMPTY_HOME_STATE,
  HomeStateSchema,
  ITEM_KEY_RE,
  MAX_PINS,
  botIdFor,
  setArchived,
  setPinned,
  type HomeState,
} from "../shared/manage";
import { BOT_ID_RE } from "../shared/rooms/schema";
import { agentsMdFor } from "../shared/templates";
import { botDmBlockText, withBotDmBlock } from "./bot-dm-block";
import { readSettingsAt, type HostModels, type ModelPick } from "./settings";
import { AVATAR_PACK, AvatarJsonSchema, parseAvatar, type AvatarJson } from "../shared/avatar";
import {
  AVATAR_JSON_FILE,
  AVATAR_PNG_SIZE,
  AVATAR_RENDER_DIR,
  AVATAR_SIZES,
  avatarJsonHash,
  pruneRenders,
  renderAvatar,
  renderFileName,
  resvgRenderer,
  type AvatarRender,
  type AvatarRenderer,
  type SaveAvatarResult,
} from "./avatar-store";

export const HOME_FILE = ".home.json";
const PROFILE_FILE = ".optchat-profile";
const META_FILE = ".bot.json";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Refused edit; the message is shown to the owner as is. */
export class ManageError extends Error {}

async function atomicWrite(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

async function modeOf(path: string, fallback: number): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return fallback;
  }
}

/** Drops unknown keys, bad keys and pins past the cap; a file that does not parse reads as null. */
export function normaliseHomeState(raw: unknown): HomeState | null {
  const parsed = HomeStateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const pins = [...new Set(parsed.data.pins.filter((k) => ITEM_KEY_RE.test(k)))]
    .filter((k) => !(k in parsed.data.archived))
    .slice(0, MAX_PINS);
  const archived = Object.fromEntries(Object.entries(parsed.data.archived).filter(([k]) => ITEM_KEY_RE.test(k)));
  return { v: 1, pins, archived };
}

/**
 * `<bots root>/.home.json`. With no file the featured bot is pinned (today's home), so the first
 * read after the update looks the same as before. Writes are serialised in this process.
 */
export class HomeStateFile {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly path = join(root, HOME_FILE),
  ) {}

  /** `featured`: the bot pinned when there is no file yet. */
  async read(featured: string | null): Promise<HomeState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return { ...EMPTY_HOME_STATE, pins: featured ? [`bot:${featured}`] : [] };
    }
    try {
      return normaliseHomeState(JSON.parse(text)) ?? EMPTY_HOME_STATE;
    } catch {
      return EMPTY_HOME_STATE;
    }
  }

  private update(featured: string | null, change: (state: HomeState) => HomeState): Promise<HomeState> {
    const run = this.tail.catch(() => undefined).then(async () => {
      const before = await this.read(featured);
      const after = change(before);
      if (after === before && existsSync(this.path)) return before;
      if (existsSync(this.path)) await copyFile(this.path, `${this.path}.bak`);
      await atomicWrite(this.path, `${JSON.stringify(after, null, 2)}\n`, await modeOf(this.path, 0o600));
      return after;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  pin(featured: string | null, key: string, pinned: boolean): Promise<HomeState> {
    return this.update(featured, (state) => setPinned(state, key, pinned));
  }

  archive(featured: string | null, key: string, archived: boolean, now = new Date()): Promise<HomeState> {
    return this.update(featured, (state) => setArchived(state, key, archived, now.toISOString()));
  }

  /** Drops a deleted item's pin and archive entry. */
  forget(featured: string | null, key: string): Promise<HomeState> {
    return this.update(featured, (state) => {
      if (!state.pins.includes(key) && !(key in state.archived)) return state;
      const { [key]: _gone, ...archived } = state.archived;
      return { ...state, pins: state.pins.filter((k) => k !== key), archived };
    });
  }
}

/** `<dir>/avatar.json`, shape-checked; null when missing or unreadable. */
export async function readAvatarJsonAt(dir: string): Promise<AvatarJson | null> {
  try {
    const parsed = AvatarJsonSchema.safeParse(JSON.parse(await readFile(join(dir, AVATAR_JSON_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A `data:image/png;base64,…` upload as PNG bytes; throws when it is not a PNG or too large. */
export function decodePng(dataUri: string): Buffer {
  const prefix = "data:image/png;base64,";
  if (!dataUri.startsWith(prefix)) throw new ManageError("The avatar must be a PNG.");
  const bytes = Buffer.from(dataUri.slice(prefix.length), "base64");
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new ManageError("The avatar is not a PNG.");
  if (bytes.length > AVATAR_UPLOAD_MAX) throw new ManageError("The avatar is too large.");
  return bytes;
}

/**
 * Host steps a bot made in the app still needs. None since release/app: pi-optchat does git init and
 * .gitignore at its first checkpoint and runs on defaults without config.json; the bot-dm block is
 * written at create; the first chat starts at create (intro) or on first open. Kept for older apps,
 * which show the list in their toast.
 */
export const CREATE_MISSING_STEPS: string[] = [];

/** Chat model picked at create (Paseo provider string, e.g. "optchat/anthropic/claude-sonnet-5-5"). */
export interface ChatChoice {
  provider: string;
  thinkingOptionId?: string;
}

export interface CreateBotInput {
  name: string;
  /** Full AGENTS.md text (the sheet's Advanced editor). Empty: built from template + purpose. */
  agentsMd?: string;
  template?: string;
  purpose?: string;
  avatar?: string;
  /** A designed avatar (avatar.json, AV1); rendered on the host. Not together with `avatar`. */
  avatarJson?: unknown;
  chat?: ChatChoice;
}

export interface BotFilesOptions {
  /** Bots root (`~/bots`). */
  root: string;
  /** OptChat data home (`OPTCHAT_HOME`, else `~/.optchat`). */
  optchatHome?: string;
  /** SVG -> PNG for designed avatars (default: resvg-js, loaded on first use). */
  renderer?: () => Promise<AvatarRenderer>;
}

/**
 * pi-optchat's own default (`src/profiles.ts`), shown only when neither the profile nor the host
 * (setup's "Choose models", settings `models.compaction`) names a compactor.
 */
export const DEFAULT_COMPACTOR = { provider: "anthropic", model: "claude-sonnet-5-5", thinking: "medium" } as const;

/** A settings ModelPick as an OptChat ModelChoice (a model without effort runs with "off"). */
export function choiceOf(pick: ModelPick | null): CompactorChoice | null {
  return pick ? { provider: pick.provider, model: pick.model, thinking: (pick.thinking ?? "off") as CompactorChoice["thinking"] } : null;
}

/**
 * OptChat profile config.json from the host's models: `compactor` (compaction role) and the
 * upstream-required `subagent` (workers role). null when setup has not chosen yet.
 */
export function hostProfileConfig(models: HostModels): { compactor: CompactorChoice; subagent: CompactorChoice } | null {
  const compactor = choiceOf(models.compaction);
  if (!compactor) return null;
  return { compactor, subagent: choiceOf(models.workers) ?? compactor };
}
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface CompactorChoice {
  provider: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

function compactorOf(value: unknown): CompactorChoice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== "string" || typeof v.model !== "string" || typeof v.thinking !== "string") return null;
  if (!THINKING.has(v.thinking)) return null;
  return { provider: v.provider, model: v.model, thinking: v.thinking as CompactorChoice["thinking"] };
}

export class BotFiles {
  private readonly root: string;
  private readonly optchatHome: string;
  private readonly renderer: () => Promise<AvatarRenderer>;
  /** avatar.json saves run one at a time per bot, so the revision check and the writes cannot interleave. */
  private readonly avatarTails = new Map<string, Promise<unknown>>();
  constructor(options: BotFilesOptions) {
    this.root = options.root;
    this.renderer = options.renderer ?? resvgRenderer;
    this.optchatHome = resolve(options.optchatHome ?? process.env.OPTCHAT_HOME ?? join(homedir(), ".optchat"));
  }

  private botDir(botId: string): string {
    if (!BOT_ID_RE.test(botId)) throw new ManageError(`Not a bot id: ${botId}`);
    return join(this.root, botId);
  }

  /** The OptChat profile named by the bot's `.optchat-profile` (fallback: the bot id). */
  async profileDir(botId: string): Promise<string> {
    let profile = botId;
    try {
      profile = (await readFile(join(this.botDir(botId), PROFILE_FILE), "utf8")).trim() || botId;
    } catch {
      throw new ManageError(`Unknown bot: ${botId}`);
    }
    if (!BOT_ID_RE.test(profile)) throw new ManageError(`Bad profile name for ${botId}: ${profile}`);
    return join(this.optchatHome, "profiles", profile);
  }

  async agentsMd(botId: string): Promise<{ text: string; mtimeMs: number | null }> {
    const path = join(await this.profileDir(botId), "AGENTS.md");
    try {
      const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      return { text, mtimeMs: info.mtimeMs };
    } catch {
      return { text: "", mtimeMs: null };
    }
  }

  async writeAgentsMd(botId: string, text: string, baseMtimeMs: number | null): Promise<void> {
    const dir = await this.profileDir(botId);
    const path = join(dir, "AGENTS.md");
    let current: number | null = null;
    try {
      current = (await stat(path)).mtimeMs;
    } catch {
      current = null;
    }
    if (current !== baseMtimeMs) {
      throw new ManageError("AGENTS.md changed on the host since you opened it. Close and open Edit again.");
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(path, text, await modeOf(path, 0o600));
  }

  /** The profile's compactor (config.json), or pi-optchat's default when there is none. */
  async compactor(botId: string): Promise<CompactorChoice & { isDefault: boolean }> {
    const path = join(await this.profileDir(botId), "config.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return { ...this.hostCompactor(), isDefault: true };
    }
    const choice = compactorOf((raw as Record<string, unknown> | null)?.compactor);
    return choice ? { ...choice, isDefault: false } : { ...this.hostCompactor(), isDefault: true };
  }

  private hostCompactor(): CompactorChoice {
    return choiceOf(readSettingsAt(this.root).models.compaction) ?? { ...DEFAULT_COMPACTOR };
  }

  /**
   * Writes `compactor` into the profile's config.json, keeping every other key in place (old file
   * kept as config.json.bak). A profile without config.json gets pi-optchat's minimal one. A file
   * that does not parse is refused, never replaced. pi-optchat (feat/model-scope) re-reads it on
   * the next summary; older pi-optchat on the next start of the bot.
   */
  async setCompactor(botId: string, choice: CompactorChoice): Promise<CompactorChoice & { isDefault: boolean }> {
    const next = compactorOf(choice);
    if (!next) throw new ManageError("Pick a model and a thinking level.");
    const dir = await this.profileDir(botId);
    if (!existsSync(dir)) throw new ManageError(`No OptChat profile for ${botId}.`);
    const path = join(dir, "config.json");
    let config: Record<string, unknown>;
    let text: string | null = null;
    try {
      text = await readFile(path, "utf8");
    } catch {
      text = null;
    }
    if (text === null) {
      config = { compactor: next, subagent: choiceOf(readSettingsAt(this.root).models.workers) ?? next };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ManageError("The profile's config.json does not parse. Fix it on the host first.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ManageError("The profile's config.json is not an object. Fix it on the host first.");
      }
      config = parsed as Record<string, unknown>;
      config.compactor = next;
      await copyFile(path, `${path}.bak`);
    }
    await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`, await modeOf(path, 0o600));
    return { ...next, isDefault: false };
  }

  private async readMeta(botId: string): Promise<Record<string, unknown>> {
    try {
      const raw = JSON.parse(await readFile(join(this.botDir(botId), META_FILE), "utf8")) as unknown;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Merges `patch` into `.bot.json`, keeping every other key; the old file goes to `.bot.json.bak`. */
  async updateMeta(botId: string, patch: Record<string, unknown>): Promise<void> {
    const path = join(this.botDir(botId), META_FILE);
    const meta = { ...(await this.readMeta(botId)), ...patch };
    if (existsSync(path)) await copyFile(path, `${path}.bak`);
    await atomicWrite(path, `${JSON.stringify(meta)}\n`, await modeOf(path, 0o664));
  }

  /** Writes `<bot>/avatar.png` (old one kept as avatar.png.bak) and points `.bot.json` at it. */
  async setAvatar(botId: string, dataUri: string): Promise<void> {
    const bytes = decodePng(dataUri);
    const path = join(this.botDir(botId), "avatar.png");
    if (existsSync(path)) await copyFile(path, `${path}.bak`);
    await atomicWrite(path, bytes, await modeOf(path, 0o644));
    const meta = await this.readMeta(botId);
    if (meta.avatar !== "avatar.png") await this.updateMeta(botId, { avatar: "avatar.png" });
  }

  /** The stored avatar.json (shape-checked only, so an avatar from an older pack still reads); null without one. */
  async avatarJson(botId: string): Promise<AvatarJson | null> {
    const dir = this.botDir(botId);
    if (!existsSync(join(dir, PROFILE_FILE))) throw new ManageError(`Unknown bot: ${botId}`);
    return readAvatarJsonAt(dir);
  }

  /**
   * Saves a designed avatar (spec §3). Kept only when its revision is above the stored one; a resend of the
   * stored save (same revision, same picture) answers ok with `unchanged` and writes nothing. Bad ids or a
   * newer pack than the host's: `invalid`. Unknown bot: throws.
   */
  async saveAvatarJson(botId: string, input: unknown): Promise<SaveAvatarResult> {
    const dir = this.botDir(botId);
    const run = (this.avatarTails.get(botId) ?? Promise.resolve()).catch(() => undefined).then(async (): Promise<SaveAvatarResult> => {
      if (!existsSync(join(dir, PROFILE_FILE))) throw new ManageError(`Unknown bot: ${botId}`);
      const parsed = parseAvatar(input, AVATAR_PACK);
      if (!parsed.ok) return { ok: false, reason: "invalid", error: parsed.error, packVersion: AVATAR_PACK.packVersion };
      const avatar = parsed.avatar;
      const hash = avatarJsonHash(avatar);
      const stored = await readAvatarJsonAt(dir);
      const storedHash = stored ? avatarJsonHash(stored) : null;
      if (stored && avatar.revision <= stored.revision) {
        if (avatar.revision === stored.revision && hash === storedHash) {
          return { ok: true, reason: "saved", revision: stored.revision, hash, unchanged: true, renderMs: null };
        }
        return { ok: false, reason: "stale", revision: stored.revision, hash: storedHash };
      }
      const rendered = await renderAvatar(avatar, await this.renderer());
      await this.writeDesigned(dir, avatar, rendered, storedHash);
      return { ok: true, reason: "saved", revision: avatar.revision, hash, unchanged: false, renderMs: rendered.ms };
    });
    const tail = run.catch(() => undefined);
    this.avatarTails.set(botId, tail);
    void tail.then(() => {
      if (this.avatarTails.get(botId) === tail) this.avatarTails.delete(botId);
    });
    return run;
  }

  /**
   * Writes a rendered avatar into `dir`: the renders, avatar.png (+ .bak), `.bot.json` avatar, then avatar.json
   * (+ .bak) last, so a crash part way leaves the old avatar.json and a resend redoes the save. Then drops renders
   * other than this picture's and `previousHash`'s.
   */
  private async writeDesigned(dir: string, avatar: AvatarJson, rendered: AvatarRender, previousHash: string | null): Promise<void> {
    const renders = join(dir, AVATAR_RENDER_DIR);
    await mkdir(renders, { recursive: true, mode: 0o755 });
    for (const size of AVATAR_SIZES) {
      await atomicWrite(join(renders, renderFileName(rendered.hash, size)), rendered.pngs[size], 0o644);
    }
    const png = join(dir, "avatar.png");
    if (existsSync(png)) await copyFile(png, `${png}.bak`);
    await atomicWrite(png, rendered.pngs[AVATAR_PNG_SIZE], await modeOf(png, 0o644));
    const meta = join(dir, META_FILE);
    let current: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(await readFile(meta, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) current = raw as Record<string, unknown>;
    } catch {
      current = {};
    }
    if (current.avatar !== "avatar.png") {
      if (existsSync(meta)) await copyFile(meta, `${meta}.bak`);
      await atomicWrite(meta, `${JSON.stringify({ ...current, avatar: "avatar.png" })}\n`, await modeOf(meta, 0o664));
    }
    const json = join(dir, AVATAR_JSON_FILE);
    if (existsSync(json)) await copyFile(json, `${json}.bak`);
    await atomicWrite(json, `${JSON.stringify(avatar)}\n`, await modeOf(json, 0o644));
    await pruneRenders(renders, [rendered.hash, previousHash]);
  }

  async rename(botId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new ManageError("Give it a name.");
    if (!existsSync(join(this.botDir(botId), PROFILE_FILE))) throw new ManageError(`Unknown bot: ${botId}`);
    await this.updateMeta(botId, { name: trimmed });
  }

  /**
   * A new bot from its name: the folder id comes from the name ("Tweety Bird" -> tweety-bird) and
   * must be free both under the bots root and among the OptChat profiles.
   */
  async create(input: CreateBotInput): Promise<{ botId: string; missing: string[] }> {
    const name = input.name.trim();
    const botId = botIdFor(name);
    if (!botId || !BOT_ID_RE.test(botId)) throw new ManageError("Use letters or numbers in the name.");
    const dir = join(this.root, botId);
    const profile = join(this.optchatHome, "profiles", botId);
    if (existsSync(dir)) throw new ManageError(`A bot folder ${botId} already exists.`);
    if (existsSync(profile)) throw new ManageError(`An OptChat profile ${botId} already exists.`);
    if (input.avatar && input.avatarJson !== undefined) throw new ManageError("Send a picture or a designed avatar, not both.");
    let designed: { avatar: AvatarJson; rendered: AvatarRender } | null = null;
    if (input.avatarJson !== undefined) {
      const parsed = parseAvatar(input.avatarJson, AVATAR_PACK);
      if (!parsed.ok) throw new ManageError(`The avatar is not valid: ${parsed.error}`);
      designed = { avatar: parsed.avatar, rendered: await renderAvatar(parsed.avatar, await this.renderer()) };
    }
    const avatar = designed ? designed.rendered.pngs[AVATAR_PNG_SIZE] : input.avatar ? decodePng(input.avatar) : null;
    if (input.chat && !input.chat.provider.startsWith("optchat/")) throw new ManageError("Pick an OptChat model.");
    const body = input.agentsMd?.trim() ? input.agentsMd : agentsMdFor({ name, template: input.template, purpose: input.purpose });
    // The bot-dm block, so the bot knows how to DM other bots and the user (no snippet sync needed).
    const agentsMd = withBotDmBlock(body.endsWith("\n") ? body : `${body}\n`, botDmBlockText(readSettingsAt(this.root)));
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await atomicWrite(join(profile, "AGENTS.md"), agentsMd);
    // The host's compaction and worker models (setup), so a new bot never falls back to a fixed model.
    // `setup: true`: copied from the host, so a later "Choose models" updates it (onboarding.applyToBots).
    const hostConfig = hostProfileConfig(readSettingsAt(this.root).models);
    if (hostConfig) await atomicWrite(join(profile, "config.json"), `${JSON.stringify({ ...hostConfig, setup: true }, null, 2)}\n`, 0o600);
    await mkdir(join(dir, "dm"), { recursive: true, mode: 0o700 });
    if (avatar && !designed) await atomicWrite(join(dir, "avatar.png"), avatar, 0o644);
    await atomicWrite(
      join(dir, META_FILE),
      `${JSON.stringify({
        name,
        order: 10,
        icon: "Bot",
        ...(avatar ? { avatar: "avatar.png" } : {}),
        ...(input.chat ? { chat: { provider: input.chat.provider, ...(input.chat.thinkingOptionId ? { thinkingOptionId: input.chat.thinkingOptionId } : {}) } } : {}),
      })}\n`,
      0o664,
    );
    if (designed) await this.writeDesigned(dir, designed.avatar, designed.rendered, null);
    // Last: the profile marker is what makes the folder a bot (discoverBots).
    await atomicWrite(join(dir, PROFILE_FILE), `${botId}\n`);
    return { botId, missing: [...CREATE_MISSING_STEPS] };
  }

  /**
   * Delete bot (release/app): nothing is erased. The bot folder and its OptChat profile move to
   * `<bots root>/.trash/<id>-<time>/` (bot/ and profile/), so a mistake can be undone by moving them
   * back. The caller archives the bot's chats first and removes it from the home state. Refused
   * while a group still has the bot as a member.
   */
  async remove(botId: string, groupsWithBot: string[] = [], now = new Date()): Promise<{ trash: string }> {
    const dir = this.botDir(botId);
    if (!existsSync(join(dir, PROFILE_FILE))) throw new ManageError(`Unknown bot: ${botId}`);
    if (groupsWithBot.length) {
      throw new ManageError(`Remove ${botId} from ${groupsWithBot.join(", ")} first.`);
    }
    const profile = await this.profileDir(botId);
    const trash = join(this.root, ".trash", `${botId}-${now.toISOString().replace(/[:.]/g, "-")}`);
    // Never follow a symlinked bot folder out of the bots root.
    if (!realpathSync(dir).startsWith(realpathSync(this.root))) throw new ManageError(`${botId} is outside the bots root.`);
    await mkdir(trash, { recursive: true, mode: 0o700 });
    if (existsSync(profile)) await rename(profile, join(trash, "profile"));
    await rename(dir, join(trash, "bot"));
    return { trash };
  }
}
