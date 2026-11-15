/**
 * Where a Claude Code bot's memory summaries run (FF1). One summary tree and job queue (server/cc/engine.ts); only the runner
 * changes:
 *
 * - `in-session`: the bot's own Claude Code TUI answers the job with `$.model.complete` (the inbox mod), on a Claude
 *   family alias. Settings value `"in-session"` (aliases `"cc"`, `"claude-code"`).
 * - `pi`: the host's pi CLI answers it (server/cc/pi-runner.ts) with the profile's compactor model verbatim, on the host's pi
 *   sign-in, so any model pi has (a cheap ChatGPT or local one) can write the summaries.
 *
 * Per bot: OptChat profile `config.json` `compactorRunner`. Global default: bots settings `compactorRunner`. Absent:
 * automatic.
 */
export type CompactorRunner = "in-session" | "pi";
export const COMPACTOR_RUNNERS = ["in-session", "pi"] as const;

/** A settings value as a runner; null (automatic) for anything else. */
export function parseRunner(value: unknown): CompactorRunner | null {
  if (value === "pi") return "pi";
  if (value === "in-session" || value === "cc" || value === "claude-code") return "in-session";
  return null;
}

/** A compactor Claude Code itself can run: pi's `anthropic` provider with a `claude-…` model. */
export function isClaudeCompactor(c: { provider?: unknown; model?: unknown } | null | undefined): boolean {
  return c?.provider === "anthropic" && typeof c.model === "string" && /^claude-/.test(c.model);
}

export type RunnerWhy = "bot" | "model" | "host" | "default";

/**
 * The runner in effect: the bot's own setting; else pi when the model is not one Claude Code can run (it used to fall
 * back to Haiku silently); else the host default; else in-session.
 */
export function resolveRunner(input: {
  bot: CompactorRunner | null;
  compactor: { provider?: unknown; model?: unknown } | null | undefined;
  host: CompactorRunner | null;
}): { runner: CompactorRunner; why: RunnerWhy } {
  if (input.bot) return { runner: input.bot, why: "bot" };
  if (!isClaudeCompactor(input.compactor)) return { runner: "pi", why: "model" };
  if (input.host) return { runner: input.host, why: "host" };
  return { runner: "in-session", why: "default" };
}
