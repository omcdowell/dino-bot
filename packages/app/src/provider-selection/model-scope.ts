import type { ProviderModelScope } from "@getpaseo/protocol/messages";
import type { ProviderSelectionModelRow } from "./provider-selection";

/** The model picker's two lists for a provider with a scope (Pi-based providers). */
export type ModelScopeTab = "scoped" | "all";

/** A scope the picker can show: the host supports it for this provider. */
export function usableModelScope(scope: ProviderModelScope | null | undefined) {
  return scope && scope.supported ? scope : null;
}

/** Opens on Scoped when it has models, otherwise on All. */
export function initialModelScopeTab(scope: ProviderModelScope | null): ModelScopeTab {
  return scope && scope.scopedModelIds.length > 0 ? "scoped" : "all";
}

/**
 * Rows for the tab. Scoped keeps Pi's scope order; All is the whole catalogue unfiltered (the owner,
 * 19 Oct: "dont hide anything"). Without a scope every row is shown.
 */
export function rowsForModelScopeTab(
  rows: ProviderSelectionModelRow[],
  scope: ProviderModelScope | null,
  tab: ModelScopeTab,
): ProviderSelectionModelRow[] {
  if (!scope || tab === "all") return rows;
  const byId = new Map(rows.map((row) => [row.modelId, row]));
  return scope.scopedModelIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

export type ModelScopeMark = "scoped" | "scopedByPattern" | "unscoped";

/** How a row's tick reads: in Scoped, in Scoped through a glob entry, or not in Scoped. */
export function modelScopeMark(scope: ProviderModelScope | null, modelId: string): ModelScopeMark {
  if (!scope || !scope.scopedModelIds.includes(modelId)) return "unscoped";
  return scope.globModelIds.includes(modelId) ? "scopedByPattern" : "scoped";
}

/**
 * The scope as it will read once a toggle lands, so the tick flips at once. The host's answer
 * replaces it (globs, order).
 */
export function optimisticModelScope(
  scope: ProviderModelScope,
  modelId: string,
  scoped: boolean,
): ProviderModelScope {
  const has = scope.scopedModelIds.includes(modelId);
  if (scoped === has) return scope;
  return scoped
    ? { ...scope, scopedModelIds: [...scope.scopedModelIds, modelId] }
    : {
        ...scope,
        scopedModelIds: scope.scopedModelIds.filter((id) => id !== modelId),
        globModelIds: scope.globModelIds.filter((id) => id !== modelId),
      };
}
