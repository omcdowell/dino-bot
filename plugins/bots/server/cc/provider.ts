/**
 * Paseo provider `optchat-cc`: a bot whose chat runs on Claude Code (the user's own login) with OptChat memory.
 *
 * The chat is an ordinary Paseo agent (label bot=<id>), so the app's chat, bot-dm, rooms, previews and push work as
 * for pi bots. A prompt goes into the bot's engine inbox (engine.ts); the bot's Claude Code TUI in herdr takes it
 * (the inbox mod) and reports its steps and tool calls back, which become the agent's timeline here.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
  type ProviderContent,
  type ProviderCommand,
} from "@getpaseo/plugin/server/provider";
import type { CcEngine, CcEvent, CcHost } from "./engine";
import { ccProxyFor, findClaude, type CcLauncher } from "./launch";
import { aliasesOnly, CC_EFFORTS, CcModels, effortOption, modelSource, withModel, type CcModel } from "./models";
import { ccToolDetail } from "./tool-detail";
import { parseTaskNotification, taskNotificationItem } from "./task-notification";
import { CcUsageLedger } from "./usage";
import { isBotTraffic } from "./deliver";
import { skillCommandText, skillPrompt, type CcSkill } from "./skills";
import { addHidden, ccPersistence, hiddenOf, listCcSessions, rewindRange, shown, type Hidden } from "./sessions";
import { OPTCHAT_COMMAND, optchatCommand, withProfileLock } from "./profile-tools";

export const CC_PROVIDER = "optchat-cc";
/**
 * prompt.steer: a message sent while a turn runs is taken for that turn and goes into the inbox like any other; the
 * engine types it once the TUI is free (it never types into a running turn), so it is answered next.
 * permission: a prompt held in the bot's terminal is a card in the app (and a push); it is answered there.
 * prompt.command: the app's slash commands, as a pi bot's (commandList); /optchat is the profile tools (profile-tools.ts).
 * session.list, session.revert.conversation: sessions.ts.
 */
const CAPABILITIES = [
  "prompt.message",
  "prompt.image",
  "prompt.steer",
  "prompt.command",
  "session.persistence",
  "session.configure",
  "session.list",
  "session.revert.conversation",
  "permission",
] as const;

/** pi-optchat's answer to /compact (its session_before_compact hook), worded for Claude Code. */
const COMPACT_NOTE = "OptChat manages history between turns: it compacts after every turn, so there is nothing to compact now.";

/**
 * The app's slash commands for a bot on Claude Code, as pi offers them to a pi bot: /compact (OptChat answers it, as
 * on pi), /optchat (the profile tools) and /skill:<name> for each skill in the bot's prompt (pi's skill commands). The
 * commands of pi's own packages are pi's.
 */
export function commandList(skills: readonly CcSkill[]): ProviderCommand[] {
  return [
    { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
    OPTCHAT_COMMAND,
    ...skills.map((k) => ({ name: `skill:${k.name}`, description: k.description })),
  ];
}
/** Every level, for a model whose levels are not known (Claude Code lowers one the model does not take). */
const EFFORTS = CC_EFFORTS.map(effortOption);

export interface CcProviderDeps {
  host: CcHost;
  launcher: CcLauncher;
  /** The bots root (~/bots): a bot is a folder there with an .optchat-profile. */
  botsRoot: string;
  /** OPTCHAT_HOME (~/.optchat): profiles live in its profiles/. */
  optchatHome: string;
  warn?: (s: string) => void;
  /** The model list for a bot's folder (or the daemon's default): server/cc/models.ts, live from the Models API. */
  models?: (cwd: string | undefined, env: Record<string, string | undefined>) => Promise<CcModel[]>;
  /** Names the list `models` gives a folder now (CcModels.catalogKey), so the daemon rebuilds its snapshot when it changes. */
  catalogKey?: (cwd: string | undefined, env: Record<string, string | undefined>) => string;
  /** The bots plugin's shared skills folder (plugins/bots/skills), listed in each bot's prompt (skills.ts). */
  skillsDir?: string;
}

/** The bot and its OptChat profile folder for a chat's cwd, or an error a person can act on. */
export function resolveBot(cwd: string, botsRoot: string, optchatHome: string): { bot: string; profileDir: string } {
  const dir = resolve(cwd);
  if (dirname(dir) !== resolve(botsRoot)) throw new Error(`A Claude Code bot chat runs in a bot folder (${botsRoot}/<bot>), not ${cwd}.`);
  let profile = "";
  try {
    profile = readFileSync(join(dir, ".optchat-profile"), "utf8").trim();
  } catch {}
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error(`${dir} has no OptChat profile (.optchat-profile).`);
  return { bot: basename(dir), profileDir: join(optchatHome, "profiles", profile) };
}

const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** The prompt's text; images are kept in the profile (images/<sha256>.<ext>) and named by path, as pi-optchat does. */
export function promptText(content: readonly ProviderContent[], profileDir: string): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image") {
      const bytes = Buffer.from(c.data, "base64");
      const path = join(profileDir, "images", `${createHash("sha256").update(bytes).digest("hex")}.${IMAGE_EXT[c.mimeType] ?? "bin"}`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600 });
      parts.push(`[image: ${path} (read the file to see it)]`);
    } else if (typeof (c as { text?: unknown }).text === "string") parts.push((c as unknown as { text: string }).text); // a text attachment
  }
  return parts.join("\n").trim();
}

const IMAGE_LINE = / ?\n?\[image: (\/[^\n]*?) \(read the file to see it\)\]/g;

/**
 * A logged user message as the person sent it (the inverse of promptText): the text without the image lines, and
 * the images, read back from the profile's images/ (a line naming a file that is not there stays).
 */
export function promptImages(text: string, profileDir: string): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const dir = join(resolve(profileDir), "images") + "/";
  const mimeOf = Object.fromEntries(Object.entries(IMAGE_EXT).map(([mime, ext]) => [ext, mime]));
  const images: Array<{ data: string; mimeType: string }> = [];
  const rest = text.replace(IMAGE_LINE, (line, path: string) => {
    const mimeType = mimeOf[path.slice(path.lastIndexOf(".") + 1)];
    if (!mimeType || !resolve(path).startsWith(dir)) return line;
    try {
      images.push({ data: readFileSync(path).toString("base64"), mimeType });
      return "";
    } catch {
      return line;
    }
  });
  return images.length ? { text: rest.trim(), images } : { text, images };
}

/** What pi-optchat logged for an image before it kept images (its text memory had no bytes or path). */
const PI_IMAGE_PLACEHOLDER = "[image attachment: available in Pi session; text memory does not preserve image bytes]";
/** Shown for each such image in a reopened chat. */
export const IMAGE_NOT_KEPT = "(image not kept)";

/**
 * A logged user message from a bot's time on pi, before images were kept: each placeholder becomes a short note and
 * Pi's resize notes (`[Image: original …]`, about the copy only the Pi session has) go. Other text is left as it is.
 */
export function piImageText(text: string): string {
  if (!text.includes(PI_IMAGE_PLACEHOLDER)) return text;
  return text
    .replace(/\n\n(?:\[Image[ :][^\n]*\]\n)+(?=\[image attachment: )/g, "\n")
    .split(PI_IMAGE_PLACEHOLDER)
    .join(IMAGE_NOT_KEPT)
    .trim();
}

/** The first bot folder (by name) whose .bot.json names an Anthropic API proxy (launch.ts ccProxyFor), if any. */
export function firstProxiedBot(botsRoot: string): string | undefined {
  try {
    for (const name of readdirSync(botsRoot).sort()) {
      if (name.startsWith(".")) continue;
      const dir = join(botsRoot, name);
      if (ccProxyFor(dir, {})) return dir;
    }
  } catch {}
  return undefined;
}

/** Why a turn failed, for the chat: Claude Code's own words when it gave any. */
function turnError(reason: "refusal" | "error", detail: string | undefined): string {
  if (reason === "refusal") return `The model refused${detail ? `: ${detail}` : " this request."}`;
  return detail ? `Claude Code: ${detail}` : "Claude Code stopped on an API error (see the bot's terminal).";
}

type TimelineItem = Extract<ProviderEvent, { type: "timeline.item" }>["item"];

/**
 * A reopened chat's history from the bot's OptChat log (engine.recent): its messages, and each `tool` entry
 * (`<name> <input JSON>`) as a finished tool row with the result its `echo` (`<name>: [error] <text>`) logged, paired
 * by name in order. Thinking is not logged, so it does not come back.
 */
export function replayItems(entries: ReturnType<CcEngine["recent"]>): Array<{ timestamp: string; item: TimelineItem }> {
  const out: Array<{ timestamp: string; item: TimelineItem }> = [];
  const open: Array<{ name: string; input: unknown; at: number }> = [];
  for (const e of entries) {
    const id = `m-${e.i}`;
    if (e.kind === "user") out.push({ timestamp: e.date, item: { type: "user_message", id, text: skillCommandText(e.text) || e.text, revertToken: { i: e.i } } });
    else if (e.kind === "talk") out.push({ timestamp: e.date, item: { type: "assistant_message", id, text: e.text } });
    else if (e.kind === "tool") {
      const sp = e.text.indexOf(" ");
      const name = sp < 0 ? e.text : e.text.slice(0, sp);
      let input: unknown = null;
      try {
        input = JSON.parse(e.text.slice(sp + 1));
      } catch {}
      open.push({ name, input, at: out.length });
      out.push({ timestamp: e.date, item: { type: "tool_call", id, callId: id, name, detail: ccToolDetail({ name, input, done: true }), status: "completed", error: null } as never });
    } else if (e.kind === "echo") {
      const k = open.findIndex((o) => e.text.startsWith(`${o.name}: `));
      if (k < 0) continue;
      const [o] = open.splice(k, 1);
      const rest = e.text.slice(o!.name.length + 2);
      const isError = rest.startsWith("[error] ");
      const output = isError ? rest.slice(8) : rest;
      const row = out[o!.at]!.item as TimelineItem & { detail: unknown; status: string; error: unknown };
      Object.assign(row, { detail: ccToolDetail({ name: o!.name, input: o!.input, output, done: true, isError }), ...(isError ? { status: "failed", error: output } : {}) });
    }
  }
  return out;
}

const afterView = (t: string) => (t.startsWith("<chat>") && t.includes("</chat>") ? t.slice(t.indexOf("</chat>") + 7).trim() : t);

interface Session {
  id: string;
  bot: string;
  cwd: string;
  profileDir: string;
  engine: CcEngine;
  env: Record<string, string | undefined>;
  model?: string;
  effort?: string;
  /** Turns Paseo started (prompt sent), oldest first, not yet run by the TUI. */
  waiting: string[];
  /** Messages steered into a turn (prompt.steer), in the inbox: typed, each runs as a turn of its own. */
  steered: Set<string>;
  /** Stop was pressed while these were being typed: each turn gets Esc as soon as Claude Code takes it. */
  stopping: Set<string>;
  current: string | null;
  step: number;
  /** The permission card for a prompt held in the bot's terminal, until the bot moves on or the owner dismisses it. */
  blocked: string | null;
  /** The slash commands last sent to the app (JSON), so an unchanged list is not sent again. */
  commands: string;
  /** Log ranges this chat rewound past (sessions.ts); they ride in its persistence. */
  hidden: Hidden;
  stop: () => void;
}

/** The folder a catalogue is listed for: a bot's folder, else none (the daemon's default source, else the first bot with a proxy). */
export function catalogCwd(cwd: string | undefined, deps: Pick<CcProviderDeps, "botsRoot" | "optchatHome">): string | undefined {
  let out: string | undefined;
  if (cwd)
    try {
      resolveBot(cwd, deps.botsRoot, deps.optchatHome);
      out = resolve(cwd);
    } catch {}
  // Asked for no bot, and the daemon has no proxy or Claude login of its own: the first bot with a proxy.
  if (!out && !modelSource(undefined, process.env)) out = firstProxiedBot(deps.botsRoot);
  return out;
}

/** The engine a bot's .bot.json `chat` names (part of the catalogue key: an engine switch rebuilds the snapshot). */
function chatEngine(cwd: string | undefined): string {
  if (!cwd) return "";
  try {
    const chat = (JSON.parse(readFileSync(join(cwd, ".bot.json"), "utf8")) as { chat?: { provider?: unknown } }).chat;
    return typeof chat?.provider === "string" ? chat.provider : "";
  } catch {
    return "";
  }
}

export function createCcProvider(deps: CcProviderDeps): ProviderRegistration {
  // One model list cache for the catalogue key and every connection, so the key names the list a catalogue gets.
  const live = deps.models ? null : new CcModels({ warn: deps.warn });
  const shared: CcProviderDeps = live
    ? { ...deps, models: (cwd, env) => live.list(cwd, env), catalogKey: (cwd, env) => live.catalogKey(cwd, env) }
    : deps;
  return {
    id: CC_PROVIDER,
    // The daemon keeps a folder's catalogue under this key: without one it kept the first list (aliases only, if it was
    // built while the bot had no proxy) until a forced refresh.
    async getCatalogCacheKey(options) {
      const cwd = catalogCwd(options.scope === "workspace" ? options.cwd : undefined, deps);
      const key = shared.catalogKey?.(cwd, process.env);
      return key === undefined ? undefined : `${cwd ?? "(daemon)"} ${chatEngine(cwd)} ${key}`;
    },
    label: "Claude Code",
    description: "OptChat bots on your own Claude Code login",
    async status() {
      return findClaude() ? { available: true } : { available: false, diagnostic: "Claude Code (claude) is not installed on this computer." };
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return connection(shared, negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

function connection(deps: CcProviderDeps, capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  /** The session that shows a bot's turns: the one opened or prompted last. */
  const owner = new Map<string, string>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const l of listeners) l(event);
  };
  const warn = deps.warn ?? (() => {});
  /** Each bot's usage ledger (server/cc/usage.ts): the context meter's fill and the chat's cost. */
  const ledgers = new Map<string, CcUsageLedger>();
  const ledger = (bot: string) => {
    let l = ledgers.get(bot);
    if (!l) ledgers.set(bot, (l = new CcUsageLedger(join(deps.host.botDir(bot), "usage.json"))));
    return l;
  };
  // createCcProvider always passes one (the shared list cache).
  const models = deps.models ?? (async () => aliasesOnly());
  const configEvent = async (s: Session): Promise<ProviderEvent> => {
    const list = withModel(await models(s.cwd, s.env), s.model);
    const levels = list.find((m) => m.id === s.model)?.thinkingOptions ?? EFFORTS;
    return { type: "session.config", sessionId: s.id, config: { model: s.model, thinkingOption: s.effort, models: list, modes: [], thinkingOptions: levels, settings: [] } };
  };

  const startTui = (s: Session) =>
    deps.launcher
      .ensure(s.bot, { cwd: s.cwd, stateDir: deps.host.botDir(s.bot), env: s.env, model: s.model, effort: s.effort })
      .catch((error: Error) => {
        warn(`cc ${s.bot}: ${error.message}`);
        emit({ type: "session.notice", sessionId: s.id, notice: { id: `tui-${Date.now()}`, severity: "error", title: "Claude Code did not start", description: error.message } });
      });

  /** The bot's engine (opened on first use); messages are typed into its TUI (herdr agent prompt): deliver.ts. */
  const engineFor = async (bot: string, profileDir: string, env: Record<string, string | undefined>, cwd: string) => {
    const engine = await deps.host.engine(bot, profileDir, { env, warn, botDir: resolve(cwd), skillsDir: deps.skillsDir });
    if (typeof deps.launcher.delivery === "function") engine.setDelivery(deps.launcher.delivery(bot));
    return engine;
  };

  /** `/optchat <args>` (profile-tools.ts): its answer is a notice row, as pi-optchat's notify on a pi bot. */
  async function command(s: Session, id: string, name: string, args: string) {
    const note = (level: "info" | "error", message: string) => emit({ type: "timeline.item", sessionId: s.id, item: { type: "notification", id: `cmd-${id}`, level, message } });
    try {
      if (name !== OPTCHAT_COMMAND.name) throw new Error(`Claude Code bots have /${OPTCHAT_COMMAND.name} only.`);
      const mine = [...sessions.values()].filter((o) => o.bot === s.bot);
      note(
        "info",
        await optchatCommand(args, {
          bot: s.bot,
          profileDir: s.profileDir,
          memory: s.engine.memory,
          usage: ledger(s.bot).usage(s.id),
          busy: mine.some((o) => o.current || o.waiting.length) || !s.engine.idle() || s.engine.queued > 0,
          reopen: async (swap) => {
            // The engine lets the profile go (memory closed, lock freed), the swap runs under the lock, and every chat
            // of the bot follows the engine opened on the new memory; the TUI's mods re-read engine.json.
            await deps.host.close(s.bot);
            await withProfileLock(s.profileDir, s.bot, swap);
            const engine = await engineFor(s.bot, s.profileDir, s.env, s.cwd);
            for (const o of mine) {
              o.stop();
              o.engine = engine;
              o.stop = engine.onEvent((e) => onEngine(o, e));
            }
            const shower = mine.find((o) => owner.get(o.bot) === o.id) ?? s;
            engine.setRun({ model: shower.model, effort: shower.effort });
          },
        }),
      );
    } catch (error) {
      note("error", (error as Error).message);
    }
    emit({ type: "session.prompt_result", sessionId: s.id, clientMessageId: id, result: { type: "completed" } });
  }

  /** The chat that shows the bot's turns; the TUI runs on its model and effort. */
  const own = (s: Session) => {
    owner.set(s.bot, s.id);
    s.engine.setRun({ model: s.model, effort: s.effort });
  };

  const unblock = (s: Session) => {
    if (!s.blocked) return;
    emit({ type: "session.permission_resolved", sessionId: s.id, permissionId: s.blocked });
    s.blocked = null;
  };

  /** The app's slash commands (commandList), sent when they changed (a skill added or removed). */
  const publishCommands = (s: Session) => {
    let skills: CcSkill[] = [];
    try {
      skills = s.engine.skills();
    } catch (error) {
      warn(`cc ${s.bot}: skills: ${(error as Error).message}`);
    }
    const commands = commandList(skills);
    const json = JSON.stringify(commands);
    if (json === s.commands) return;
    s.commands = json;
    emit({ type: "session.commands", sessionId: s.id, commands });
  };

  function onEngine(s: Session, e: CcEvent) {
    if (owner.get(s.bot) !== s.id) return;
    // The bot moved on: what held it in the terminal was answered there.
    if (e.type !== "blocked" && e.type !== "usage" && e.type !== "extra-usage" && e.type !== "session" && e.type !== "warning") unblock(s);
    type Item = Extract<ProviderEvent, { type: "timeline.item" }>["item"];
    const item = (it: Item) => emit({ type: "timeline.item", sessionId: s.id, item: it, timestamp: new Date().toISOString() });
    /** A prompt the TUI submitted itself: Claude Code's notice that a background task ended is no message of the person's, a row for the task. */
    const submitted = (raw: string, origin: string | undefined, id: string) => {
      const text = afterView(raw);
      const notice = parseTaskNotification(text) ?? (origin === "task-notification" ? { taskId: null, toolUseId: null, status: null, summary: text.slice(0, 300) || null, outputFile: null } : null);
      item(notice ? taskNotificationItem(notice, id) : { type: "user_message", id: `u-${id}`, text, revertToken: { turn: id } });
    };
    switch (e.type) {
      case "started": {
        const ours = e.id !== null && s.waiting.includes(e.id);
        s.current = ours ? e.id : (e.id ?? `t-${Date.now().toString(36)}`);
        s.step = 0;
        s.waiting = s.waiting.filter((id) => id !== e.id);
        if (e.id !== null && s.stopping.delete(e.id)) void deps.launcher.interrupt(s.bot).catch(() => {});
        if (e.id !== null && s.steered.delete(e.id)) {
          // A steered message, shown when it was sent: its turn starts now.
          emit({ type: "session.turn", sessionId: s.id, turnId: e.id, state: "started" });
        } else if (!ours) {
          submitted(e.text, e.origin, s.current!);
          emit({ type: "session.turn", sessionId: s.id, turnId: s.current!, state: "started" });
        }
        return;
      }
      case "into":
        // Into the running turn: its row, and the turn (the person's, say) goes on and ends as it would.
        submitted(e.text, e.origin, `${s.current ?? "t"}-${Date.now().toString(36)}`);
        return;
      case "step":
        // The same id while the answer streams (partial), as for thinking: Paseo shows only what is new.
        if (s.current) item({ type: "assistant_message", id: `a-${s.current}-${e.partial ? s.step : s.step++}`, text: e.answer });
        return;
      case "thinking":
        // The same id with the text grown: Paseo shows only what is new, as one thinking row (as for pi bots).
        if (s.current) item({ type: "reasoning", id: `r-${s.current}-${e.block}`, text: e.text });
        return;
      case "tool":
        if (!s.current) return;
        item({
          type: "tool_call",
          id: `c-${e.id}`,
          callId: e.id,
          name: e.name,
          detail: ccToolDetail({ name: e.name, input: e.input, output: e.output, done: e.phase === "done", isError: e.isError }),
          ...(e.images?.length ? { images: e.images } : {}),
          ...(e.phase === "running" ? { status: "running", error: null } : e.isError ? { status: "failed", error: e.output ?? "failed" } : { status: "completed", error: null }),
        } as never);
        return;
      case "usage":
      case "extra-usage": {
        const l = ledger(s.bot);
        // A compaction with no known price still counts its tokens.
        const usage = e.type === "usage" ? l.run(s.id, e.usage) : l.extra(s.id, e.tokens, e.costUsd ?? 0);
        emit({ type: "session.usage", sessionId: s.id, ...(s.current ? { turnId: s.current } : {}), usage });
        return;
      }
      case "merged":
        // Answered inside the turn that was running: its own turn ends with it.
        s.stopping.delete(e.id);
        if (s.steered.delete(e.id)) return;
        if (!s.waiting.includes(e.id)) return;
        s.waiting = s.waiting.filter((id) => id !== e.id);
        emit({ type: "session.turn", sessionId: s.id, turnId: e.id, state: "completed" });
        return;
      case "undelivered":
        s.stopping.delete(e.id);
        if (s.steered.delete(e.id)) {
          emit({ type: "session.notice", sessionId: s.id, notice: { id: `undelivered-${e.id}`, severity: "error", title: "Message not delivered", description: `${e.reason}.` } });
          return;
        }
        if (!s.waiting.includes(e.id)) return;
        s.waiting = s.waiting.filter((id) => id !== e.id);
        emit({ type: "session.turn", sessionId: s.id, turnId: e.id, state: "failed", error: { message: `Not delivered: ${e.reason}.` } });
        emit({ type: "session.notice", sessionId: s.id, notice: { id: `undelivered-${e.id}`, severity: "error", title: "Message not delivered", description: `${e.reason}.` } });
        return;
      case "blocked":
        // A card, not a notice: Paseo marks the chat for attention and pushes, as for a pi bot's permission request.
        unblock(s);
        s.blocked = `blocked-${e.since}`;
        emit({
          type: "session.permission",
          sessionId: s.id,
          request: {
            id: s.blocked,
            name: "Claude Code",
            kind: "other",
            title: "Waiting in the bot's terminal",
            description: `Claude Code waits for an approval or an answer in the bot's terminal (herdr tab cc-${s.bot}); answer it there. Messages go once it is answered.`,
            actions: [{ id: "dismiss", label: "Dismiss", behavior: "deny", intent: "dismiss" }],
          },
        });
        return;
      case "warning":
        item({ type: "notification", id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, level: "error", message: e.text });
        return;
      case "complete":
        if (!s.current) return;
        // Only an interrupt is a cancel: a refusal or an API error (retries exhausted, the context limit) failed, with why.
        if (e.reason === "refusal" || e.reason === "error")
          emit({ type: "session.turn", sessionId: s.id, turnId: s.current, state: "failed", error: { message: turnError(e.reason, e.detail) } });
        else emit({ type: "session.turn", sessionId: s.id, turnId: s.current, state: e.aborted ? "canceled" : "completed" });
        s.current = null;
        return;
      case "session":
        // A new TUI said hello (the old one crashed, or its tab closed and started again): the turn it ran is over,
        // and no turn.complete will come for it. As pi's process exit: that turn failed.
        if (!s.current) return;
        emit({ type: "session.turn", sessionId: s.id, turnId: s.current, state: "failed", error: { message: "Claude Code restarted during this turn." } });
        s.current = null;
        return;
    }
  }

  async function open(input: Extract<ProviderInput, { type: "session.open" }>) {
    const { bot, profileDir } = resolveBot(input.config.cwd, deps.botsRoot, deps.optchatHome);
    const env = { ...process.env, ...input.config.env };
    const engine = await engineFor(bot, profileDir, env, input.config.cwd);
    const s: Session = {
      id: input.sessionId,
      bot,
      cwd: resolve(input.config.cwd),
      profileDir,
      engine,
      env,
      model: input.config.model || undefined,
      effort: input.config.thinkingOption || undefined,
      waiting: [],
      steered: new Set(),
      stopping: new Set(),
      current: null,
      step: 0,
      blocked: null,
      commands: "",
      hidden: hiddenOf(input.persistence),
      stop: () => {},
    };
    s.stop = engine.onEvent((e) => onEngine(s, e));
    sessions.set(s.id, s);
    own(s);
    emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: s.id,
      capabilities,
      restoration: "core",
      persistence: ccPersistence(bot, s.hidden),
      title: input.config.title,
      cwd: s.cwd,
    });
    emit(await configEvent(s));
    publishCommands(s);
    // What this chat counted before (a reopened chat, a restarted daemon): the meter shows it until the next turn.
    const known = ledger(bot).usage(s.id);
    if (known) emit({ type: "session.usage", sessionId: s.id, usage: known });
    if (input.history === "replay")
      for (const r of replayItems(engine.recent().filter(shown(s.hidden)))) {
        // The images the person sent show again, as on a pi bot's reopened chat (the app stores them by content).
        const sent = r.item.type === "user_message" ? promptImages(r.item.text, profileDir) : null;
        const item = sent ? { ...r.item, text: piImageText(sent.text), ...(sent.images.length ? { images: sent.images } : {}) } : r.item;
        emit({ type: "timeline.item", sessionId: s.id, timestamp: r.timestamp, item });
      }
    emit({ type: "session.ready", requestId: input.requestId, sessionId: s.id });
    void startTui(s);
  }

  function prompt(input: Extract<ProviderInput, { type: "session.prompt" }>) {
    const s = sessions.get(input.sessionId)!;
    const p = input.prompt;
    const fail = (message: string) =>
      emit({ type: "session.prompt_result", sessionId: s.id, clientMessageId: p.clientMessageId, result: { type: "failed", error: { message } } });
    publishCommands(s);
    let text: string;
    let display: string;
    if (p.input.type === "command") {
      const { name, arguments: args } = p.input;
      if (name === OPTCHAT_COMMAND.name) return void command(s, p.clientMessageId, name, args);
      if (name === "compact") {
        // As on a pi bot (pi-optchat cancels pi's compaction and says why): a note, no turn.
        emit({ type: "timeline.item", sessionId: s.id, item: { type: "notification", id: `n-${p.clientMessageId}`, level: "info", message: COMPACT_NOTE } as never });
        emit({ type: "session.prompt_result", sessionId: s.id, clientMessageId: p.clientMessageId, result: { type: "completed" } });
        return;
      }
      const skill = name.startsWith("skill:") ? s.engine.skills().find((k) => k.name === name.slice(6)) : undefined;
      if (!skill) return fail(`Unknown command: /${name}`);
      try {
        text = skillPrompt(skill, args);
      } catch (error) {
        return fail(`Cannot read the skill ${skill.name}: ${(error as Error).message}`);
      }
      display = `/${name}${args.trim() ? ` ${args.trim()}` : ""}`;
    } else {
      text = promptText(p.input.content, s.profileDir);
      if (!text) return fail("The message is empty.");
      display = text;
    }
    const turnId = p.clientMessageId;
    if (p.delivery === "steer") {
      // Into the turn Paseo last saw start: the latest one sent, else the one the TUI runs. None: Paseo sends it as a turn.
      const active = s.waiting.at(-1) ?? s.current;
      if (!active) return fail("No turn is running to steer into.");
      own(s);
      emit({ type: "timeline.item", sessionId: s.id, item: { type: "user_message", id: `u-${turnId}`, text: display, clientMessageId: turnId, revertToken: { turn: turnId } } });
      s.engine.enqueue(text, turnId);
      s.steered.add(turnId);
      emit({ type: "session.prompt_result", sessionId: s.id, clientMessageId: turnId, result: { type: "steer", turnId: active } });
      void startTui(s);
      return;
    }
    own(s);
    emit({ type: "timeline.item", sessionId: s.id, item: { type: "user_message", id: `u-${turnId}`, text: display, clientMessageId: turnId, revertToken: { turn: turnId } } });
    s.engine.enqueue(text, turnId);
    s.waiting.push(turnId);
    emit({ type: "session.prompt_result", sessionId: s.id, clientMessageId: turnId, result: { type: "turn", turnId } });
    emit({ type: "session.turn", sessionId: s.id, turnId, state: "started" });
    void startTui(s);
  }

  async function dispatch(input: ProviderInput) {
    switch (input.type) {
      case "catalog": {
        // A bot's folder (the app asks per workspace) names its proxy; else the daemon's default source.
        const cwd = catalogCwd(input.cwd, deps);
        emit({ type: "catalog", requestId: input.requestId, catalog: { models: await models(cwd, process.env), modes: [], thinkingOptions: EFFORTS } });
        return;
      }
      case "session.configure": {
        const s = sessions.get(input.sessionId)!;
        const { model, thinkingOption } = input.changes;
        if (model !== undefined) s.model = model || undefined;
        if (thinkingOption !== undefined) s.effort = thinkingOption || undefined;
        emit(await configEvent(s));
        emit({ type: "request.completed", requestId: input.requestId });
        // The TUI's next step runs on them (the inbox mod's turn.step asks /run), as a pi bot's setModel: no restart.
        if (owner.get(s.bot) === s.id) s.engine.setRun({ model: s.model, effort: s.effort });
        return;
      }
      case "sessions":
        emit({ type: "sessions", requestId: input.requestId, sessions: listCcSessions(input, deps.botsRoot, deps.optchatHome, deps.host.engines.keys()) });
        return;
      case "session.revert": {
        // As pi: not while a turn runs (Paseo stops it first). The chat stops showing the message and what followed.
        const s = sessions.get(input.sessionId)!;
        try {
          if (input.scope !== "conversation") throw new Error("Claude Code bots rewind the conversation only.");
          if (s.current || s.waiting.length) throw new Error("Cannot rewind while a turn is running.");
          s.hidden = addHidden(s.hidden, rewindRange(input.token, s.engine.memory.root));
        } catch (error) {
          emit({ type: "request.failed", requestId: input.requestId, error: { message: (error as Error).message } });
          return;
        }
        emit({ type: "session.persistence", sessionId: s.id, persistence: ccPersistence(s.bot, s.hidden) });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.open":
        try {
          await open(input);
        } catch (error) {
          emit({ type: "request.failed", requestId: input.requestId, error: { message: (error as Error).message } });
        }
        return;
      case "session.prompt":
        prompt(input);
        return;
      case "session.permission": {
        // Dismissed in the app: the prompt itself is answered in the terminal.
        const s = sessions.get(input.sessionId);
        if (s && s.blocked === input.permissionId) unblock(s);
        return;
      }
      case "session.interrupt": {
        const s = sessions.get(input.sessionId);
        if (s) {
          // A running turn gets Esc. The owner's own messages still waiting are dropped. Bot DMs and room messages
          // still go, as for a bot on pi, where they were steered into the turn already: typed, they start the next
          // turn (typed text lifts Claude Code's hold after a Stop). The owner's message being typed cannot be taken
          // back: its turn gets Esc as soon as Claude Code takes it.
          const kept: string[] = [];
          for (const id of s.waiting) {
            const text = s.engine.itemText(id);
            if (text !== undefined && isBotTraffic(text)) kept.push(id);
            else if (s.engine.cancel(id) || text === undefined) emit({ type: "session.turn", sessionId: s.id, turnId: id, state: "canceled" });
            else {
              kept.push(id);
              s.stopping.add(id);
            }
          }
          s.waiting = kept;
          if (s.current) await deps.launcher.interrupt(s.bot).catch(() => {});
        }
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close": {
        const s = sessions.get(input.sessionId);
        if (s) {
          s.stop();
          sessions.delete(s.id);
          if (owner.get(s.bot) === s.id) owner.delete(s.bot);
        }
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      default:
        if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { message: `Claude Code bots do not support ${input.type}.` } });
    }
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      if ("sessionId" in input && input.type !== "session.open" && !sessions.has(input.sessionId)) throw new Error(`Unknown session: ${input.sessionId}`);
      queueMicrotask(() => void dispatch(input).catch((error) => warn(`cc provider: ${(error as Error).message}`)));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      for (const s of sessions.values()) s.stop();
      sessions.clear();
      listeners.clear();
    },
  };
}
