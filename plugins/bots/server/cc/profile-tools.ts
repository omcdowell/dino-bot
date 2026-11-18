/**
 * `/optchat` for a Claude Code bot, from the app: the profile tools pi-optchat's `/optchat` gives a pi bot (browse,
 * import, usage, settings, instructions), on the same OptChat profile files. Each action answers with text for the chat.
 *
 * What differs from pi (declared): no interactive pickers. pi's import picker and its usage and settings pages are pi
 * TUI components (on a pi bot in the app, usage and settings refuse with "requires interactive Pi"), and a Claude Code
 * bot's terminal takes no `/optchat` (it runs with slash commands off). Here usage and settings are text, settings are
 * changed in the app's Edit bot sheet or the profile's config.json, and an import is staged with pi-optchat's import
 * CLI (as onboarding does); this command finishes or discards it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exportBrowser } from "pi-optchat/src/browser.ts";
import { backgroundState, discardBackground, finishBackground } from "pi-optchat/src/import/auto.ts";
import { pendingImport } from "pi-optchat/src/import/job.ts";
import { lockProfile } from "pi-optchat/src/lock.ts";
import type { Memory } from "pi-optchat/src/memory.ts";
import type { ProviderCommand, ProviderUsage } from "@getpaseo/plugin/server/provider";

export const OPTCHAT_ACTIONS = ["browse", "import", "usage", "settings", "instructions"] as const;

export const OPTCHAT_COMMAND: ProviderCommand = {
  name: "optchat",
  description: "OptChat memory browser, imports, usage, settings and instructions for this bot",
  argumentHint: `[${OPTCHAT_ACTIONS.join("|")}]`,
};

export interface ProfileToolsContext {
  bot: string;
  /** The OptChat profile folder (~/.optchat/profiles/<name>). */
  profileDir: string;
  memory: Memory;
  /** This chat's figures (server/cc/usage.ts), if any were counted. */
  usage: ProviderUsage | null;
  /** A turn runs or waits for this bot: an import cannot switch memory now. */
  busy: boolean;
  /**
   * Closes the bot's engine (its Memory and the profile lock), runs `swap` holding the lock, and opens the engine
   * again on the profile's active memory: what pi-optchat's `/optchat import` does with a new session.
   */
  reopen: (swap: () => void) => Promise<void>;
}

const IMPORT_CLI = "pi-optchat's import CLI (tsx src/import/cli.ts start|run <profile>)";
const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The text answer to `/optchat <args>`. Throws an Error a person can act on. */
export async function optchatCommand(args: string, c: ProfileToolsContext): Promise<string> {
  const [action = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const profile = c.profileDir.split("/").pop()!;
  switch (action) {
    case "":
      return [
        `OptChat · ${profile} · ${c.memory.root.length} messages · ${c.memory.pending} pending`,
        c.memory.lastError ?? "",
        `/optchat ${OPTCHAT_ACTIONS.join(" | ")}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "browse":
      return `Memory browser written: ${exportBrowser(c.memory, profile, c.profileDir)}\nOpen it in a browser on this computer.`;
    case "instructions": {
      const file = join(c.profileDir, "AGENTS.md");
      const size = existsSync(file) ? readFileSync(file, "utf8").length : 0;
      return `${profile}'s instructions: ${file} (${size} characters). Ask the bot to change them, or edit the file; they apply from the next turn.`;
    }
    case "usage":
      return usageText(c);
    case "settings":
      return settingsText(c.profileDir);
    case "import":
      return importAction(rest[0] ?? "", c);
    default:
      throw new Error(`Use /optchat [${OPTCHAT_ACTIONS.join("|")}].`);
  }
}

function usageText(c: ProfileToolsContext): string {
  const lines = [`Usage · ${c.bot}`];
  const u = c.usage;
  if (u) {
    const input = (u.inputTokens ?? 0) + (u.cachedInputTokens ?? 0);
    lines.push(
      `This chat: ${dollars(u.totalCostUsd ?? 0)} · ${input} input tokens (${input ? Math.round((100 * (u.cachedInputTokens ?? 0)) / input) : 0}% cached) · ${u.outputTokens ?? 0} output`,
    );
    if (u.contextWindowMaxTokens && u.contextWindowUsedTokens !== undefined)
      lines.push(`Context: ${u.contextWindowUsedTokens} of ${u.contextWindowMaxTokens} tokens`);
  } else lines.push("This chat: nothing counted yet.");
  // Summaries: compactor-usage.jsonl (engine.ts), one line per summary, by runner.
  const runs = new Map<string, { n: number; usd: number; tokens: number }>();
  try {
    for (const line of readFileSync(join(c.profileDir, "compactor-usage.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const key = `${e.runner ?? "in-session"} ${e.model ?? "?"}`;
        const r = runs.get(key) ?? { n: 0, usd: 0, tokens: 0 };
        r.n++;
        r.usd += typeof e.costUsd === "number" ? e.costUsd : 0;
        const t = e.usage ?? {};
        for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "input", "output", "cacheRead", "cacheWrite"])
          if (typeof t[k] === "number") r.tokens += t[k];
        runs.set(key, r);
      } catch {}
    }
  } catch {}
  if (runs.size) for (const [key, r] of runs) lines.push(`Summaries (${key}): ${r.n} · ${r.tokens} tokens${r.usd ? ` · ${dollars(r.usd)}` : ""}`);
  else lines.push("Summaries: none logged.");
  return lines.join("\n");
}

function settingsText(profileDir: string): string {
  const file = join(profileDir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const shown = Object.entries(config).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return [
    `Settings (${file}):`,
    ...(shown.length ? shown : ["(none: OptChat's defaults)"]),
    "Change the summary model and where summaries run in the app (bot > Edit), or edit config.json; the bot reads it at the next summary.",
  ].join("\n");
}

async function importAction(step: string, c: ProfileToolsContext): Promise<string> {
  const dir = c.profileDir;
  const bg = backgroundState(dir);
  const pending = pendingImport(dir);
  switch (step) {
    case "":
    case "status": {
      if (pending) return `A paused import (${pending.mode}, ${pending.added} messages) waits in this profile: resume or discard it on a pi chat of this profile (/optchat import).`;
      if (!bg) return `No import. Stage one with ${IMPORT_CLI}; when it is built, /optchat import finish switches this bot to it.`;
      if (bg.status === "ready") return "The background import is built. /optchat import finish switches this bot's memory to it (old chats summarised); /optchat import discard drops it.";
      const p = bg.progress ? ` · ${bg.progress.messages} of ${bg.progress.total} messages` : "";
      return `Background import: ${bg.status}${p}${bg.reason ? ` (${bg.reason})` : ""}. Build it with ${IMPORT_CLI}; /optchat import discard drops it.`;
    }
    case "finish": {
      if (!bg || bg.status !== "ready") throw new Error("No built background import to finish (/optchat import shows its state).");
      if (c.busy) throw new Error("Finish or stop the bot's turn before switching its memory.");
      let added = 0;
      await c.reopen(() => {
        added = finishBackground(dir).added;
      });
      return `Imported ${added} messages into ${dir.split("/").pop()}. The bot uses the new memory from its next turn; the previous memory is kept.`;
    }
    case "discard":
      if (!bg) throw new Error("No background import to discard.");
      discardBackground(dir);
      return "Background import discarded. The bot's memory is unchanged.";
    default:
      throw new Error("Use /optchat import [status|finish|discard].");
  }
}

/** Holds the profile lock (pi-optchat's lock.sock) while `swap` runs: the engine has let it go. */
export async function withProfileLock(profileDir: string, bot: string, swap: () => void) {
  const unlock = await lockProfile(profileDir, `DinoBot Claude Code bot ${bot}: /optchat import (pid ${process.pid})`);
  try {
    swap();
  } finally {
    await unlock();
  }
}
