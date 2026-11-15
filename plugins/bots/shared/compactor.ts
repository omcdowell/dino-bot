/** The Edit sheet's compaction model: OptChat's `{ provider, model, thinking }` <-> Paseo model ids. */
import { COMPACTOR_THINKING, type Compactor, type CompactorRunnerSetting } from "./manage-rpc";
import { isClaudeCompactor, parseRunner, resolveRunner, type CompactorRunner } from "./compactor-runner";

/** Paseo's optchat catalogue names a model `<pi provider>/<pi model id>`. */
export function compactorModelId(choice: { provider: string; model: string }): string {
  return `${choice.provider}/${choice.model}`;
}

/** Back from the picker; an unknown thinking level falls back to medium (OptChat's default). */
export function compactorFromModelId(modelId: string, thinking: string | null): Compactor | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return null;
  const level = COMPACTOR_THINKING.find((value) => value === thinking) ?? "medium";
  return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1), thinking: level };
}

export function compactorLabel(choice: Compactor): string {
  return `${compactorModelId(choice)} · ${choice.thinking}`;
}

/** Where summaries would run with these choices (shared/compactor-runner.ts: the host's own rules). */
export function runnerPreview(setting: CompactorRunnerSetting, choice: Compactor, hostRunner: CompactorRunner | null): CompactorRunner {
  return resolveRunner({ bot: parseRunner(setting), compactor: choice, host: hostRunner }).runner;
}

/** One line under the runner choice: what it means for this model. */
export function runnerNote(setting: CompactorRunnerSetting, choice: Compactor, effective: CompactorRunner): string {
  if (effective === "pi") return "Summaries run on this computer's pi sign-in. If pi fails, they run in the Claude Code session.";
  if (!isClaudeCompactor(choice)) return "Claude Code can only run Claude models: this runs as Claude Haiku. Choose pi or Automatic to use this model.";
  return setting === "auto" ? "Summaries run in the bot's Claude Code session (Automatic)." : "Summaries run in the bot's Claude Code session.";
}
