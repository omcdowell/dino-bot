/**
 * Claude Code in setup's "Choose models" (v0.1.12 fix: the CC-only setup loop). When Claude Code is signed in, its
 * models (server/cc/models.ts: the aliases, then the ids the Models API lists) join pi's in setup.models under the
 * provider `claude-code`, each with Claude Code's effort levels. A `claude-code` pick then runs where Claude Code runs:
 *   bots        the chat provider optchat-cc/<model> (server/cc/provider.ts)
 *   compaction  `anthropic/claude-…` in the OptChat profile: a Claude compactor runs in the bot's own Claude Code
 *               session (shared/compactor-runner.ts; an alias becomes `claude-<alias>`, whose family it keeps)
 *   workers     settings models.workers as is; launch-cc.sh hands the model to `claude --model`
 * Pi's own defaults (pi settings.json) are never set to a Claude Code model: pi cannot run one.
 */
import type { HostModels, ModelPick } from "../settings";
import type { CcModel } from "./models";

export const CC_SETUP_PROVIDER = "claude-code";
/** Claude Code's --effort levels (the same list the chat's effort picker shows, server/cc/provider.ts). */
export const CC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type SetupModel = { provider: string; id: string; name: string; levels: string[] };

export const isCcPick = (pick: ModelPick | null | undefined): boolean => pick?.provider === CC_SETUP_PROVIDER;

/** Claude Code's model list in setup.models' shape. */
export function ccSetupModels(list: readonly CcModel[]): SetupModel[] {
  return list.map((m) => ({ provider: CC_SETUP_PROVIDER, id: m.id, name: m.label || m.id, levels: [...CC_EFFORTS] }));
}

/**
 * Suggestions for a Claude Code login, as pi-optchat's model-defaults rows for a Claude plan: Opus for chats on Max,
 * else Sonnet; Sonnet (medium) for summaries (the owner, 15 Nov) and workers. Aliases, so they follow new models.
 */
export function ccSuggested(plan: string | null | undefined): HostModels {
  const pick = (model: string): ModelPick => ({ provider: CC_SETUP_PROVIDER, model, thinking: "medium" });
  return { bots: pick(/max/i.test(plan ?? "") ? "opus" : "sonnet"), compaction: pick("sonnet"), workers: pick("sonnet") };
}

/** The chat provider a bots pick runs on: optchat-cc/<model> for Claude Code, else OptChat on pi. */
export function ccChatProvider(pick: ModelPick): string {
  return isCcPick(pick) ? `optchat-cc/${pick.model}` : `optchat/${pick.provider}/${pick.model}`;
}

/** A pick as an OptChat compactor/subagent: Claude Code's become `anthropic/claude-…` (Claude Code runs those). */
export function ccCompactorPick(pick: ModelPick): ModelPick {
  if (!isCcPick(pick)) return pick;
  return { provider: "anthropic", model: /^claude-/.test(pick.model) ? pick.model : `claude-${pick.model}`, thinking: pick.thinking };
}
