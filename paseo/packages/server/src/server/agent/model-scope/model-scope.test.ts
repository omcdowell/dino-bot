import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { expandBraces, isGlobPattern, matchesGlob } from "./glob.js";
import {
  ModelScopeError,
  addToPiScope,
  removeFromPiScope,
  resolvePiModelScope,
  type PiScopeModel,
} from "./pi-scope.js";
import { PiSettingsFile } from "./pi-settings-file.js";
import { ModelScopeService, resolvePiSettingsPath, toPiScopeModel } from "./model-scope-service.js";

const m = (ref: string, name?: string): PiScopeModel => {
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1), ...(name ? { name } : {}) };
};
const CATALOG = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-sonnet-5-20260101",
  "openai-codex/gpt-5.6-luna",
  "openrouter/z-ai/glm-5.3",
  "openrouter/z-ai/glm-5.2",
  "openrouter/anthropic/claude-opus-5-5",
  "mlx-dspark-adaptive/qwen-a",
  "mlx-dspark-adaptive/qwen-b",
  "cursor/claude-5-sonnet",
].map((ref) => m(ref));
const refs = (models: { model: PiScopeModel }[]) =>
  models.map(({ model }) => `${model.provider}/${model.id}`);

describe("glob", () => {
  test("star stays in a segment, double star spans segments", () => {
    expect(matchesGlob("mlx/qwen", "mlx/*")).toBe(true);
    expect(matchesGlob("openrouter/z-ai/glm", "openrouter/*")).toBe(false);
    expect(matchesGlob("openrouter/z-ai/glm", "openrouter/**")).toBe(true);
    expect(matchesGlob("openrouter/z-ai/glm", "openrouter/**/glm")).toBe(true);
  });
  test("case-insensitive, ?, classes, braces, dot segments", () => {
    expect(matchesGlob("Anthropic/Claude-Opus", "anthropic/*opus")).toBe(true);
    expect(matchesGlob("a/glm-5.3", "a/glm-5.?")).toBe(true);
    expect(matchesGlob("a/glm-5.3", "a/glm-5.[12]")).toBe(false);
    expect(matchesGlob("a/glm-5.3", "a/glm-5.[!12]")).toBe(true);
    expect(matchesGlob("a/x", "{a,b}/x")).toBe(true);
    expect(matchesGlob("a/.hidden", "a/*")).toBe(false);
    expect(expandBraces("{a,b{c,d}}")).toEqual(["a", "bc", "bd"]);
    expect(isGlobPattern("a/b")).toBe(false);
    expect(isGlobPattern("a/*")).toBe(true);
  });
});

describe("resolvePiModelScope (port of Pi's resolveModelScopeFromModels)", () => {
  test("exact, glob, partial and thinking suffixes, no duplicates", () => {
    const { scopedModels, diagnostics } = resolvePiModelScope(
      [
        "anthropic/claude-opus-5-5",
        "mlx-dspark-adaptive/*",
        "openai-codex/gpt-5.6-luna:high",
        "glm-5.3",
        "anthropic/claude-opus-5-5",
        "nope/missing",
      ],
      CATALOG,
    );
    expect(refs(scopedModels)).toEqual([
      "anthropic/claude-opus-5-5",
      "mlx-dspark-adaptive/qwen-a",
      "mlx-dspark-adaptive/qwen-b",
      "openai-codex/gpt-5.6-luna",
      "openrouter/z-ai/glm-5.3",
    ]);
    expect(scopedModels[3]?.thinkingLevel).toBe("high");
    expect(scopedModels[1]?.pattern).toBe("mlx-dspark-adaptive/*");
    expect(diagnostics.map((d) => d.pattern)).toEqual(["nope/missing"]);
  });
  test("a bare id that names two providers is not an exact match; partial prefers aliases", () => {
    // "claude-opus-5-5" is both anthropic/ and openrouter/anthropic/...: partial match picks one alias.
    const { scopedModels } = resolvePiModelScope(["sonnet-5"], CATALOG);
    expect(refs(scopedModels)).toEqual(["anthropic/claude-sonnet-5-5"]);
  });
  test("glob over bare ids and with a level", () => {
    const { scopedModels } = resolvePiModelScope(["z-ai/glm*:low", "*glm*"], CATALOG);
    expect(refs(scopedModels)).toEqual(["openrouter/z-ai/glm-5.3", "openrouter/z-ai/glm-5.2"]);
    expect(scopedModels.every((s) => s.thinkingLevel === "low")).toBe(true);
  });
});

describe("add / remove", () => {
  const luna = m("openai-codex/gpt-5.6-luna");
  test("add appends the exact reference once", () => {
    const next = addToPiScope(["anthropic/claude-opus-5-5"], luna, CATALOG);
    expect(next).toEqual(["anthropic/claude-opus-5-5", "openai-codex/gpt-5.6-luna"]);
    expect(addToPiScope(next, luna, CATALOG)).toEqual(next);
    expect(
      addToPiScope(["mlx-dspark-adaptive/*"], m("mlx-dspark-adaptive/qwen-a"), CATALOG),
    ).toEqual(["mlx-dspark-adaptive/*"]);
    expect(addToPiScope(undefined, luna, CATALOG)).toEqual(["openai-codex/gpt-5.6-luna"]);
  });
  test("remove drops exact entries (any spelling) and leaves the rest", () => {
    expect(
      removeFromPiScope(
        ["anthropic/claude-opus-5-5", "openai-codex/gpt-5.6-luna:high", "gpt-5.6-luna"],
        luna,
        CATALOG,
      ),
    ).toEqual(["anthropic/claude-opus-5-5"]);
  });
  test("remove from a glob spells out the glob's other matches with its level", () => {
    expect(
      removeFromPiScope(
        ["anthropic/claude-opus-5-5", "mlx-dspark-adaptive/*:high"],
        m("mlx-dspark-adaptive/qwen-a"),
        CATALOG,
      ),
    ).toEqual(["anthropic/claude-opus-5-5", "mlx-dspark-adaptive/qwen-b:high"]);
  });
  test("removing the last model or from an empty scope is refused", () => {
    expect(() => removeFromPiScope(["openai-codex/gpt-5.6-luna"], luna, CATALOG)).toThrow(
      ModelScopeError,
    );
    expect(() => removeFromPiScope(undefined, luna, CATALOG)).toThrow(ModelScopeError);
  });
});

describe("PiSettingsFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("changes only enabledModels, keeps key order, indent, newline state and mode", async () => {
    const path = join(dir, "settings.json");
    const original = `{\n    "theme": "dark",\n    "enabledModels": [\n        "a/b"\n    ],\n    "zeta": {\n        "x": 1\n    }\n}`;
    await writeFile(path, original, { mode: 0o600 });
    const file = new PiSettingsFile(path);
    expect(await file.readEnabledModels()).toEqual(["a/b"]);
    await file.updateEnabledModels((current) => [...(current ?? []), "c/d"]);
    const text = await readFile(path, "utf8");
    expect(text).toBe(
      `{\n    "theme": "dark",\n    "enabledModels": [\n        "a/b",\n        "c/d"\n    ],\n    "zeta": {\n        "x": 1\n    }\n}`,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(stat(`${path}.lock`)).rejects.toThrow();
  });

  test("a missing key goes last; a missing file is created", async () => {
    const path = join(dir, "settings.json");
    await writeFile(path, `{\n  "theme": "dark"\n}\n`);
    await new PiSettingsFile(path).updateEnabledModels(() => ["a/b"]);
    expect(await readFile(path, "utf8")).toBe(
      `{\n  "theme": "dark",\n  "enabledModels": [\n    "a/b"\n  ]\n}\n`,
    );
    const fresh = join(dir, "nested", "settings.json");
    expect(await new PiSettingsFile(fresh).readEnabledModels()).toBeUndefined();
    await new PiSettingsFile(fresh).updateEnabledModels(() => ["x/y"]);
    expect(JSON.parse(await readFile(fresh, "utf8"))).toEqual({ enabledModels: ["x/y"] });
  });

  test("waits for Pi's lock and takes over a stale one", async () => {
    const path = join(dir, "settings.json");
    await writeFile(path, `{}`);
    await mkdir(`${path}.lock`);
    const file = new PiSettingsFile(path);
    const pending = file.updateEnabledModels(() => ["a/b"]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await rm(`${path}.lock`, { recursive: true });
    await pending;
    expect(JSON.parse(await readFile(path, "utf8")).enabledModels).toEqual(["a/b"]);

    await mkdir(`${path}.lock`);
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(`${path}.lock`, old, old);
    await file.updateEnabledModels(() => ["c/d"]);
    expect(JSON.parse(await readFile(path, "utf8")).enabledModels).toEqual(["c/d"]);
  });

  test("a file that does not parse is not overwritten", async () => {
    const path = join(dir, "settings.json");
    await writeFile(path, `{ nope`);
    await expect(new PiSettingsFile(path).updateEnabledModels(() => ["a/b"])).rejects.toThrow(
      /does not parse/,
    );
    expect(await readFile(path, "utf8")).toBe(`{ nope`);
  });
});

describe("ModelScopeService", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-scope-svc-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const paseoModels: AgentModelDefinition[] = CATALOG.map((model) => ({
    provider: "optchat",
    id: `${model.provider}/${model.id}`,
    label: model.id,
    metadata: { provider: model.provider, modelId: model.id },
  }));
  const service = (base: string | null = "pi") =>
    new ModelScopeService({
      getProviderBaseId: () => base,
      getProviderConfigEnv: () => ({ PI_CODING_AGENT_DIR: dir }),
      listModels: async () => paseoModels,
      env: {},
    });

  test("reads the scope with glob ids and unmatched entries", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        enabledModels: ["anthropic/claude-opus-5-5", "mlx-dspark-adaptive/*", "gone/x"],
      }),
    );
    const view = await service().get("optchat");
    expect(view).toMatchObject({
      supported: true,
      settingsPath: join(dir, "settings.json"),
      scopedModelIds: [
        "anthropic/claude-opus-5-5",
        "mlx-dspark-adaptive/qwen-a",
        "mlx-dspark-adaptive/qwen-b",
      ],
      globModelIds: ["mlx-dspark-adaptive/qwen-a", "mlx-dspark-adaptive/qwen-b"],
      unmatchedPatterns: ["gone/x"],
    });
  });

  test("adds and removes through the file; unknown models and non-Pi providers are refused", async () => {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ enabledModels: ["anthropic/claude-opus-5-5"] }),
    );
    const svc = service();
    const added = await svc.set("optchat", "openrouter/z-ai/glm-5.3", true);
    expect(added.scopedModelIds).toEqual(["anthropic/claude-opus-5-5", "openrouter/z-ai/glm-5.3"]);
    const removed = await svc.set("optchat", "anthropic/claude-opus-5-5", false);
    expect(removed.patterns).toEqual(["openrouter/z-ai/glm-5.3"]);
    await expect(svc.set("optchat", "nope/x", true)).rejects.toThrow(
      /not in the optchat catalogue/,
    );
    expect((await service("claude").get("claude")).supported).toBe(false);
    await expect(service("claude").set("claude", "x", true)).rejects.toThrow(ModelScopeError);
  });

  test("settings path and catalogue mapping", () => {
    expect(resolvePiSettingsPath(undefined, {}, "/h")).toBe("/h/.pi/agent/settings.json");
    expect(resolvePiSettingsPath({ PI_CODING_AGENT_DIR: "~/x" }, {}, "/h")).toBe(
      "/h/x/settings.json",
    );
    expect(resolvePiSettingsPath(undefined, { PI_CODING_AGENT_DIR: "/p" }, "/h")).toBe(
      "/p/settings.json",
    );
    expect(
      toPiScopeModel({ provider: "pi", id: "openrouter/z-ai/glm-5.3", label: "GLM" }),
    ).toMatchObject({
      provider: "openrouter",
      id: "z-ai/glm-5.3",
    });
    expect(toPiScopeModel({ provider: "pi", id: "bare", label: "x" })).toBeNull();
  });
});
