/** The Edit sheet's compaction model: OptChat's `{ provider, model, thinking }` <-> Paseo model ids. */
import { COMPACTOR_THINKING, type Compactor } from "./manage-rpc";

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
