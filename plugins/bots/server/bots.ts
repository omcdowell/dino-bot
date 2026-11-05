import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOT_LABEL, KEEP_LIVE_LABEL, OPTCHAT_PROVIDER, SEND_BEHAVIOR_LABEL, type Bot } from "../shared/rpc";

/** The slice of the Paseo SDK this module uses, so tests can pass a fake. */
export interface BotsPaseo {
  projects: {
    list(): Promise<{
      projects: Array<{
        projectRootPath: string;
        projectDisplayName: string;
        projectCustomName?: string | null;
      }>;
    }>;
  };
  agents: {
    list(options?: {
      filter?: { labels?: Record<string, string>; includeArchived?: boolean };
    }): Promise<{ entries: Array<{ agent: AgentLike }> }>;
    ref(id: string): {
      archive(): Promise<unknown>;
      /** Sends a user message (the new bot's intro prompt). */
      send?(text: string, options?: { messageId?: string }): Promise<unknown>;
      /** Paseo fork 0.11.2+ (chat-prefetch); older daemons lack it. Merges labels; does not resume. */
      setLabels?(labels: Record<string, string>): Promise<unknown>;
      timeline?: {
        refetch(options?: { direction?: "tail"; limit?: number; projection?: "projected" | "canonical" }): Promise<{
          entries: Array<{ timestamp: string; turnId?: string; item: { type: string; text?: string; message?: string } }>;
          hasOlder: boolean;
        }>;
      };
    };
  };
  workspaces: {
    open(cwd: string): Promise<{
      agents: {
        create(options: {
          config: { provider: string; thinkingOptionId?: string };
          title?: string;
          labels?: Record<string, string>;
        }): Promise<{ id: string }>;
      };
    }>;
  };
  config: { get(): Promise<unknown> };
}

export interface AgentLike {
  id: string;
  cwd?: string | null;
  provider?: string | null;
  /** Configured model, e.g. "anthropic/claude-opus-5-5" (the provider id is separate). */
  model?: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
  runtimeInfo?: { model?: string | null; thinkingOptionId?: string | null } | null;
  labels?: Record<string, string> | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  archivedAt?: string | null;
  /** initializing | idle | running | error | closed */
  status?: string | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
}

export interface ChatConfig {
  provider: string;
  thinkingOptionId?: string;
}

/** No model named: OptChat (pi) uses the model the user signed in with. */
export const DEFAULT_CHAT_CONFIG: ChatConfig = { provider: OPTCHAT_PROVIDER };

let defaultModel: string | null = null;
let defaultThinking: string | null = null;

/**
 * The host's bot model (setup's "Choose models": `models.bots`, else the older `defaultModel`
 * setting), e.g. "openai-codex/gpt-6-sol", and its effort. null: none (OptChat's own default).
 * No hard-coded model or effort: setup.apply sets them (27 Oct).
 */
export function setDefaultChatModel(model: string | null, thinking: string | null = null): void {
  defaultModel = model;
  defaultThinking = thinking;
}

/** Config for a new bot chat when no "bot" agent profile names a model. */
export function defaultChatConfig(): ChatConfig {
  return defaultModel
    ? { provider: `${OPTCHAT_PROVIDER}/${defaultModel}`, ...(defaultThinking ? { thinkingOptionId: defaultThinking } : {}) }
    : DEFAULT_CHAT_CONFIG;
}

/** Agent profile id whose provider/model/thinking new bot chats use. */
export const BOT_AGENT_PROFILE_ID = "bot";

const PROFILE_FILE = ".optchat-profile";
const META_FILE = ".bot.json";

function titleCase(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** A bot is any folder under `root` that holds an OptChat profile marker. */
export async function discoverBots(root: string, paseo: Pick<BotsPaseo, "projects">): Promise<Bot[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const names = new Map<string, string>();
  try {
    for (const project of (await paseo.projects.list()).projects) {
      names.set(project.projectRootPath, project.projectCustomName || project.projectDisplayName);
    }
  } catch {
    // Names fall back to the folder; discovery must not fail because the directory is busy.
  }
  const bots: Bot[] = [];
  for (const id of dirs) {
    const cwd = join(root, id);
    try {
      if (!(await readFile(join(cwd, PROFILE_FILE), "utf8")).trim()) continue;
    } catch {
      continue;
    }
    let meta: { name?: unknown; icon?: unknown; order?: unknown; avatar?: unknown; featured?: unknown } = {};
    try {
      meta = JSON.parse(await readFile(join(cwd, META_FILE), "utf8"));
    } catch {
      // optional
    }
    const projectName = names.get(cwd);
    const projectNameIsDerived = projectName === undefined || projectName === id;
    bots.push({
      id,
      cwd,
      name:
        typeof meta.name === "string" && meta.name
          ? meta.name
          : projectNameIsDerived
            ? titleCase(id)
            : projectName,
      icon: typeof meta.icon === "string" && meta.icon ? meta.icon : "Bot",
      order: typeof meta.order === "number" ? meta.order : 100,
      avatar: typeof meta.avatar === "string" && meta.avatar.trim() ? meta.avatar.trim() : null,
      featured: meta.featured === true,
      agentId: null,
    });
  }
  return withFeatured(bots.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
}

/**
 * At most one featured bot: the first that sets "featured", else the one bot with the lowest
 * `order` when no other bot shares that order. `bots` is sorted by order.
 */
export function withFeatured<T extends { order: number; featured: boolean }>(bots: T[]): T[] {
  const explicit = bots.findIndex((bot) => bot.featured);
  const pick =
    explicit >= 0 ? explicit : bots.length > 1 && bots[0]!.order < bots[1]!.order ? 0 : bots.length === 1 ? 0 : -1;
  return bots.map((bot, i) => (bot.featured === (i === pick) ? bot : { ...bot, featured: i === pick }));
}

function recency(agent: AgentLike): string {
  return agent.lastActivityAt ?? agent.updatedAt ?? "";
}

/** The bot's current chat among `agents`: a labelled chat first, else an OptChat agent started by hand in its folder. */
export function chatFor(bot: Pick<Bot, "id" | "cwd">, agents: AgentLike[]): AgentLike | null {
  const active = agents.filter((agent) => !agent.archivedAt);
  const labelled = active.filter((agent) => agent.labels?.[BOT_LABEL] === bot.id);
  const candidates = labelled.length
    ? labelled
    : active.filter(
        (agent) => !agent.labels?.[BOT_LABEL] && agent.cwd === bot.cwd && agent.provider === OPTCHAT_PROVIDER,
      );
  return [...candidates].sort((a, b) => recency(b).localeCompare(recency(a)))[0] ?? null;
}

/** The bot an agent is a chat of (current or not): its bot= label, else an OptChat agent in the bot's folder. */
export function botOfAgent(agent: AgentLike, bots: Array<Pick<Bot, "id" | "cwd">>): string | null {
  const label = agent.labels?.[BOT_LABEL];
  if (label) return bots.some((bot) => bot.id === label) ? label : null;
  if (agent.provider !== OPTCHAT_PROVIDER) return null;
  return bots.find((bot) => bot.cwd === agent.cwd)?.id ?? null;
}

async function activeAgents(paseo: Pick<BotsPaseo, "agents">): Promise<AgentLike[]> {
  return (await paseo.agents.list()).entries.map((entry) => entry.agent);
}

/** New chats follow the "bot" agent profile, so model and thinking are edited in Paseo settings. */
export async function chatConfig(paseo: Pick<BotsPaseo, "config">): Promise<ChatConfig> {
  try {
    const config = (await paseo.config.get()) as Record<string, any>;
    const profiles: unknown =
      config?.agentProfiles ?? config?.daemon?.agentProfiles ?? config?.config?.daemon?.agentProfiles;
    if (Array.isArray(profiles)) {
      const profile = profiles.find((p) => p && p.id === BOT_AGENT_PROFILE_ID);
      // A profile without a model (DinoBot's installer writes one) defers to the host's choice.
      if (profile && typeof profile.provider === "string" && profile.model) {
        return {
          provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
        };
      }
    }
  } catch {
    // fall through
  }
  return defaultChatConfig();
}

/**
 * The model and thinking an OptChat chat runs on, so a new chat keeps what the owner picked in the
 * app. Null when the chat is not OptChat or reports no model.
 */
export function carriedChatConfig(agent: AgentLike | undefined): ChatConfig | null {
  if (!agent || agent.provider !== OPTCHAT_PROVIDER) return null;
  const model = agent.runtimeInfo?.model || agent.model;
  if (!model) return null;
  const thinking = agent.effectiveThinkingOptionId || agent.runtimeInfo?.thinkingOptionId || agent.thinkingOptionId;
  return { provider: `${OPTCHAT_PROVIDER}/${model}`, ...(thinking ? { thinkingOptionId: thinking } : {}) };
}

/** The model picked when the bot was made (`chat` in its .bot.json), if any. */
export async function botChatConfig(cwd: string): Promise<ChatConfig | null> {
  try {
    const meta = JSON.parse(await readFile(join(cwd, META_FILE), "utf8")) as { chat?: unknown };
    const chat = meta.chat as { provider?: unknown; thinkingOptionId?: unknown } | undefined;
    if (!chat || typeof chat.provider !== "string" || !chat.provider.startsWith(`${OPTCHAT_PROVIDER}/`)) return null;
    return {
      provider: chat.provider,
      ...(typeof chat.thinkingOptionId === "string" && chat.thinkingOptionId ? { thinkingOptionId: chat.thinkingOptionId } : {}),
    };
  } catch {
    return null;
  }
}

export async function createChat(bot: Bot, paseo: BotsPaseo, carried?: ChatConfig | null): Promise<string> {
  const workspace = await paseo.workspaces.open(bot.cwd);
  const agent = await workspace.agents.create({
    config: carried ?? (await botChatConfig(bot.cwd)) ?? (await chatConfig(paseo)),
    title: bot.name,
    labels: { [BOT_LABEL]: bot.id, [SEND_BEHAVIOR_LABEL]: "queue", [KEEP_LIVE_LABEL]: "1" },
  });
  return agent.id;
}

/**
 * Label changes that make each bot's current chat the only keep-live chat of that bot: "1" on the
 * current chat, "0" on any other chat of the bot that still says "1". Agents the plugin does not
 * own are left alone.
 */
export function keepLiveChanges(
  bots: Array<Pick<Bot, "id" | "cwd">>,
  agents: AgentLike[],
): Array<{ agentId: string; value: "1" | "0" }> {
  const current = new Set(
    bots.map((bot) => chatFor(bot, agents)?.id).filter((id): id is string => id !== undefined),
  );
  const changes: Array<{ agentId: string; value: "1" | "0" }> = [];
  for (const agent of agents) {
    if (agent.archivedAt || !botOfAgent(agent, bots)) continue;
    const label = agent.labels?.[KEEP_LIVE_LABEL];
    if (current.has(agent.id)) {
      if (label !== "1") changes.push({ agentId: agent.id, value: "1" });
    } else if (label === "1") {
      changes.push({ agentId: agent.id, value: "0" });
    }
  }
  return changes;
}

/** Serialises work per bot so a double tap cannot create two chats. */
export class BotLocks {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(botId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    // The tail only orders work; the caller handles `next`'s failure, so the tail must never reject.
    const tail: Promise<unknown> = next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(botId) === tail) this.tails.delete(botId);
      });
    this.tails.set(botId, tail);
    return next;
  }
}

export class BotsService {
  private readonly locks = new BotLocks();
  constructor(private readonly root: string) {}

  /**
   * Applies keepLiveChanges. Runs at start (backfill), after open/newChat and from the home poll,
   * so chats started by hand pick up the label too. Returns how many labels were written.
   */
  async syncKeepLive(paseo: BotsPaseo): Promise<number> {
    const [bots, agents] = await Promise.all([discoverBots(this.root, paseo), activeAgents(paseo)]);
    let written = 0;
    for (const { agentId, value } of keepLiveChanges(bots, agents)) {
      const ref = paseo.agents.ref(agentId);
      if (!ref.setLabels) return written;
      await ref.setLabels({ [KEEP_LIVE_LABEL]: value });
      written += 1;
    }
    return written;
  }

  /** Bots with their current chat, from one directory read. */
  async list(paseo: BotsPaseo): Promise<Bot[]> {
    return (await this.listWithOwners(paseo)).bots;
  }

  /** Bots with their current chat, plus a map from any live agent id to the bot it is a chat of. */
  async listWithOwners(paseo: BotsPaseo): Promise<{ bots: Bot[]; ownerOf: (agentId: string) => string | null }> {
    const [bots, agents] = await Promise.all([discoverBots(this.root, paseo), activeAgents(paseo)]);
    const owners = new Map<string, string>();
    for (const agent of agents) {
      const owner = botOfAgent(agent, bots);
      if (owner) owners.set(agent.id, owner);
    }
    return {
      bots: bots.map((bot) => ({ ...bot, agentId: chatFor(bot, agents)?.id ?? null })),
      ownerOf: (agentId) => owners.get(agentId) ?? null,
    };
  }

  /** Bots with their current chat, the chats themselves and the owner map, from one read of each. */
  async snapshot(paseo: BotsPaseo): Promise<{ bots: Bot[]; chats: Map<string, AgentLike>; ownerOf: (agentId: string) => string | null }> {
    const [bots, agents] = await Promise.all([discoverBots(this.root, paseo), activeAgents(paseo)]);
    const owners = new Map<string, string>();
    for (const agent of agents) {
      const owner = botOfAgent(agent, bots);
      if (owner) owners.set(agent.id, owner);
    }
    const chats = new Map<string, AgentLike>();
    const withChats = bots.map((bot) => {
      const chat = chatFor(bot, agents);
      if (chat) chats.set(chat.id, chat);
      return { ...bot, agentId: chat?.id ?? null };
    });
    return { bots: withChats, chats, ownerOf: (agentId) => owners.get(agentId) ?? null };
  }

  /** Each bot's current chat, as Paseo lists it (status and attention fields included). */
  async chats(paseo: BotsPaseo): Promise<AgentLike[]> {
    const [bots, agents] = await Promise.all([discoverBots(this.root, paseo), activeAgents(paseo)]);
    return bots.map((bot) => chatFor(bot, agents)).filter((agent): agent is AgentLike => agent !== null);
  }

  /** Each bot with its current chat (null when it has none), from one directory read. */
  async botChats(paseo: BotsPaseo): Promise<Array<{ bot: Bot; chat: AgentLike | null }>> {
    const [bots, agents] = await Promise.all([discoverBots(this.root, paseo), activeAgents(paseo)]);
    return bots.map((bot) => {
      const chat = chatFor(bot, agents);
      return { bot: { ...bot, agentId: chat?.id ?? null }, chat };
    });
  }

  private async bot(botId: string, paseo: BotsPaseo): Promise<Bot> {
    const bot = (await discoverBots(this.root, paseo)).find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}. Add ${join(this.root, botId, PROFILE_FILE)}.`);
    return bot;
  }

  open(botId: string, paseo: BotsPaseo) {
    return this.locks.run(botId, async () => {
      const bot = await this.bot(botId, paseo);
      const existing = chatFor(bot, await activeAgents(paseo));
      if (existing) return { agentId: existing.id, created: false };
      return { agentId: await createChat(bot, paseo), created: true };
    });
  }

  /**
   * A just-created bot: open its first chat now and send the intro prompt, so it says hello before
   * the user opens it. Older daemons without `send` just get the chat.
   */
  introduce(botId: string, paseo: BotsPaseo, prompt: string) {
    return this.open(botId, paseo).then(async (result) => {
      const ref = paseo.agents.ref(result.agentId);
      if (ref.send) await ref.send(prompt);
      return result;
    });
  }

  /** Archives every open chat of the bot (before Delete bot moves its folder away). */
  archiveChats(botId: string, paseo: BotsPaseo) {
    return this.locks.run(botId, async () => {
      const bot = await this.bot(botId, paseo);
      const open = (await activeAgents(paseo)).filter(
        (agent) => !agent.archivedAt && (agent.labels?.[BOT_LABEL] === bot.id || (!agent.labels?.[BOT_LABEL] && agent.cwd === bot.cwd)),
      );
      for (const chat of open) await paseo.agents.ref(chat.id).archive();
      return open.length;
    });
  }

  /** Archives the bot's open chats (memory lives in the OptChat profile, not the chat) and starts a fresh one. */
  newChat(botId: string, paseo: BotsPaseo) {
    return this.locks.run(botId, async () => {
      const bot = await this.bot(botId, paseo);
      const agents = await activeAgents(paseo);
      const open = agents.filter(
        (agent) =>
          !agent.archivedAt &&
          (agent.labels?.[BOT_LABEL] === bot.id ||
            (!agent.labels?.[BOT_LABEL] && agent.cwd === bot.cwd && agent.provider === OPTCHAT_PROVIDER)),
      );
      // The new chat keeps the model and thinking of the chat it replaces (a switch made in the app).
      const carried = carriedChatConfig(chatFor(bot, agents) ?? undefined);
      for (const chat of open) await paseo.agents.ref(chat.id).archive();
      return { agentId: await createChat(bot, paseo, carried), archived: open.length };
    });
  }
}
