import { describe, expect, it } from "vitest";
import type { ProviderModelScope } from "@getpaseo/protocol/messages";
import {
  initialModelScopeTab,
  modelScopeMark,
  optimisticModelScope,
  rowsForModelScopeTab,
  usableModelScope,
} from "./model-scope";
import type { ProviderSelectionModelRow } from "./provider-selection";

const row = (modelId: string): ProviderSelectionModelRow => ({
  favoriteKey: `optchat:${modelId}`,
  provider: "optchat",
  providerLabel: "OptChat",
  modelId,
  modelLabel: modelId,
});
const rows = [
  "anthropic/claude-opus-5-5",
  "openrouter/anthropic/claude-opus-5-5",
  "cursor/claude-5-sonnet",
  "openai-codex/gpt-5.6-luna",
  "mlx/a",
].map(row);
const scope: ProviderModelScope = {
  provider: "optchat",
  supported: true,
  settingsPath: "/h/.pi/agent/settings.json",
  patterns: ["openai-codex/gpt-5.6-luna", "anthropic/claude-opus-5-5", "mlx/*"],
  scopedModelIds: ["openai-codex/gpt-5.6-luna", "anthropic/claude-opus-5-5", "mlx/a"],
  globModelIds: ["mlx/a"],
  unmatchedPatterns: [],
};

describe("model scope", () => {
  it("Scoped follows Pi's order; All shows the whole catalogue, OpenRouter and Cursor Claude included", () => {
    expect(rowsForModelScopeTab(rows, scope, "scoped").map((r) => r.modelId)).toEqual([
      "openai-codex/gpt-5.6-luna",
      "anthropic/claude-opus-5-5",
      "mlx/a",
    ]);
    expect(rowsForModelScopeTab(rows, scope, "all")).toBe(rows);
    expect(rowsForModelScopeTab(rows, null, "scoped")).toBe(rows);
  });

  it("opens on Scoped only when it has models; unsupported scopes are dropped", () => {
    expect(initialModelScopeTab(scope)).toBe("scoped");
    expect(initialModelScopeTab({ ...scope, scopedModelIds: [] })).toBe("all");
    expect(initialModelScopeTab(null)).toBe("all");
    expect(usableModelScope({ ...scope, supported: false })).toBeNull();
    expect(usableModelScope(undefined)).toBeNull();
  });

  it("marks rows and flips them optimistically", () => {
    expect(modelScopeMark(scope, "mlx/a")).toBe("scopedByPattern");
    expect(modelScopeMark(scope, "anthropic/claude-opus-5-5")).toBe("scoped");
    expect(modelScopeMark(scope, "cursor/claude-5-sonnet")).toBe("unscoped");
    const added = optimisticModelScope(scope, "cursor/claude-5-sonnet", true);
    expect(added.scopedModelIds.at(-1)).toBe("cursor/claude-5-sonnet");
    const removed = optimisticModelScope(scope, "mlx/a", false);
    expect(removed.scopedModelIds).not.toContain("mlx/a");
    expect(removed.globModelIds).toEqual([]);
    expect(optimisticModelScope(scope, "mlx/a", true)).toBe(scope);
  });
});
