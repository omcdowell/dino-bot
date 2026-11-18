import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentFeature,
  AgentModelDefinition,
  AgentMode,
  ProviderCatalog,
} from "./agent-sdk-types.js";

const mockState = vi.hoisted(() => {
  interface ConstructorEntry {
    runtimeSettings?: unknown;

    commandsRpcType?: unknown;
  }

  return {
    constructorArgs: {
      pi: [] as ConstructorEntry[],
    },
    isCommandAvailable: vi.fn(async (_command: string) => false),
    runtimeModels: new Map<string, AgentModelDefinition[]>(),
    reset() {
      this.constructorArgs.pi = [];
      this.isCommandAvailable.mockReset();
      this.isCommandAvailable.mockImplementation(async (_command: string) => false);
      this.runtimeModels.clear();
    },
  };
});

vi.mock("../../executable-resolution/executable-resolution.js", () => ({
  isCommandAvailable: mockState.isCommandAvailable,
}));

vi.mock("./providers/pi/agent.js", () => ({
  PiRpcAgentClient: class PiRpcAgentClient {
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    };
    readonly provider = "pi";
    readonly runtimeSettings?: unknown;

    constructor(options: {
      runtimeSettings?: unknown;

      commandsRpcType?: unknown;
    }) {
      this.runtimeSettings = options.runtimeSettings;
      const entry: ConstructorEntry = {
        runtimeSettings: options.runtimeSettings,
      };
      if (options.commandsRpcType !== undefined) {
        entry.commandsRpcType = options.commandsRpcType;
      }
      mockState.constructorArgs.pi.push(entry);
    }

    async createSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async resumeSession(): Promise<never> {
      throw new Error("not implemented");
    }

    async fetchCatalog(): Promise<ProviderCatalog> {
      return {
        models: mockState.runtimeModels.get(this.provider) ?? [],
        modes: [],
      };
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  },
}));

import {
  AGENT_PROVIDER_DEFINITIONS,
  buildProviderRegistry,
  createAllClients,
} from "./provider-registry.js";

const logger = createTestLogger();

beforeEach(() => {
  mockState.reset();
});

test("builds registry with no overrides — same as built-in count", () => {
  const registry = buildProviderRegistry(logger);

  expect(Object.keys(registry)).toHaveLength(AGENT_PROVIDER_DEFINITIONS.length);
});

test("includes mock provider only for development builds", () => {
  expect(buildProviderRegistry(logger).mock).toBeUndefined();
  expect(buildProviderRegistry(logger, { isDev: false }).mock).toBeUndefined();

  const registry = buildProviderRegistry(logger, { isDev: true });

  expect(registry.mock).toMatchObject({
    id: "mock",
    label: "Mock Load Test",
    defaultModeId: "load-test",
  });
});

test("built-in override applies command", () => {
  buildProviderRegistry(logger, {
    providerOverrides: {
      pi: {
        command: ["/opt/custom-claude", "--verbose"],
      },
    },
  });

  expect(mockState.constructorArgs.pi[0]).toEqual({
    runtimeSettings: {
      command: {
        mode: "replace",
        argv: ["/opt/custom-claude", "--verbose"],
      },
      env: undefined,
    },
  });
});

test("built-in override applies env", () => {
  buildProviderRegistry(logger, {
    providerOverrides: {
      pi: {
        env: {
          CLAUDE_CONFIG_DIR: "/tmp/claude",
        },
      },
    },
  });

  expect(mockState.constructorArgs.pi[0]).toEqual({
    runtimeSettings: {
      command: undefined,
      env: {
        CLAUDE_CONFIG_DIR: "/tmp/claude",
      },
    },
  });
});

test("new provider extending claude appears in registry", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      zai: {
        extends: "pi",
        label: "ZAI",
        description: "Claude with ZAI defaults",
      },
    },
  });

  expect(registry.zai).toBeDefined();
  expect(registry.zai.label).toBe("ZAI");
  expect(registry.zai.description).toBe("Claude with ZAI defaults");
  expect(registry.zai.createClient(logger).provider).toBe("zai");
});

test("custom provider extending a provider this build does not have is skipped", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      "my-agent": {
        extends: "acp",
        label: "My Agent",
        command: ["my-agent", "--acp"],
      },
    },
  });

  expect(registry["my-agent"]).toBeUndefined();
  expect(registry.pi).toBeDefined();
});

test("custom provider without label throws", () => {
  expect(() =>
    buildProviderRegistry(logger, {
      providerOverrides: {
        zai: {
          extends: "pi",
        },
      },
    }),
  ).toThrowError("Custom provider 'zai' requires a label");
});

test("enabled: false keeps provider metadata in registry", () => {
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      pi: {
        enabled: false,
      },
    },
  });

  expect(registry.pi).toMatchObject({
    id: "pi",
    label: "Pi",
    defaultModeId: null,
    enabled: false,
  });
  expect(registry.pi.modes).toEqual(
    AGENT_PROVIDER_DEFINITIONS.find((definition) => definition.id === "pi")?.modes,
  );
});

test("enabled: false still produces a client (enabled gate is enforced elsewhere)", () => {
  const clients = createAllClients(logger, {
    providerOverrides: {
      pi: {
        enabled: false,
      },
    },
  });

  expect(mockState.constructorArgs.pi.length).toBeGreaterThan(0);
  expect(clients.pi).toBeDefined();
});

test("disallowedTools flows through to runtime settings", () => {
  buildProviderRegistry(logger, {
    providerOverrides: {
      pi: {
        disallowedTools: ["WebSearch", "WebFetch"],
      },
    },
  });

  expect(mockState.constructorArgs.pi[0]).toEqual({
    runtimeSettings: {
      command: undefined,
      env: undefined,
      disallowedTools: ["WebSearch", "WebFetch"],
    },
  });
});

test("derived provider inherits and merges disallowedTools from base", () => {
  buildProviderRegistry(logger, {
    providerOverrides: {
      pi: {
        disallowedTools: ["WebSearch"],
      },
      zai: {
        extends: "pi",
        label: "ZAI",
        disallowedTools: ["ComputerUse"],
      },
    },
  });

  const zaiArgs = mockState.constructorArgs.pi.find((entry) => {
    const disallowedTools: string[] | undefined =
      typeof entry.runtimeSettings === "object" && entry.runtimeSettings !== null
        ? Reflect.get(entry.runtimeSettings, "disallowedTools")
        : undefined;
    return Array.isArray(disallowedTools) && disallowedTools.includes("ComputerUse");
  });
  expect(zaiArgs).toBeDefined();
  const zaiDisallowedTools: string[] =
    typeof zaiArgs!.runtimeSettings === "object" && zaiArgs!.runtimeSettings !== null
      ? Reflect.get(zaiArgs!.runtimeSettings, "disallowedTools")
      : [];
  expect(zaiDisallowedTools).toEqual(["WebSearch", "ComputerUse"]);
});

test("extension inherits base override — override claude command, zai extends pi gets overridden command", () => {
  buildProviderRegistry(logger, {
    providerOverrides: {
      pi: {
        command: ["/opt/custom-claude"],
      },
      zai: {
        extends: "pi",
        label: "ZAI",
      },
    },
  });

  expect(mockState.constructorArgs.pi).toHaveLength(2);
  expect(
    mockState.constructorArgs.pi.every((entry) => {
      const command: { argv?: string[] } | undefined =
        typeof entry.runtimeSettings === "object" && entry.runtimeSettings !== null
          ? Reflect.get(entry.runtimeSettings, "command")
          : undefined;
      return command?.argv?.[0] === "/opt/custom-claude";
    }),
  ).toBe(true);
});

describe("model merging", () => {
  test("profile models replace runtime models", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-pro",
        label: "Runtime Pro",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [
            {
              id: "profile-fast",
              label: "Profile Fast",
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.map((model) => model.id)).toEqual(["profile-fast"]);
  });

  test("profile models exclude runtime models entirely", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "shared-model",
        label: "Runtime Label",
      },
      {
        provider: "pi",
        id: "runtime-only",
        label: "Runtime Only",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [
            {
              id: "shared-model",
              label: "Profile Label",
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "shared-model",
        label: "Profile Label",
      },
    ]);
  });

  test("profile isDefault preserved without runtime models", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [
            {
              id: "profile-default",
              label: "Profile Default",
              isDefault: true,
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "profile-default",
        label: "Profile Default",
        isDefault: true,
      },
    ]);
  });

  test("profile thinking option default is normalized onto the model", async () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [
            {
              id: "profile-default",
              label: "Profile Default",
              isDefault: true,
              thinkingOptions: [
                { id: "off", label: "Off" },
                { id: "max", label: "Max", isDefault: true },
              ],
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "profile-default",
        label: "Profile Default",
        isDefault: true,
        thinkingOptions: [
          { id: "off", label: "Off" },
          { id: "max", label: "Max", isDefault: true },
        ],
        defaultThinkingOptionId: "max",
      },
    ]);
  });

  test("additional models append to runtime models", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-pro",
        label: "Runtime Pro",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          additionalModels: [
            {
              id: "profile-fast",
              label: "Profile Fast",
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "runtime-pro",
        label: "Runtime Pro",
      },
      {
        provider: "pi",
        id: "profile-fast",
        label: "Profile Fast",
      },
    ]);
  });

  test("built-in profile models replace runtime models (issue #1299)", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-model",
        label: "Runtime Model",
      },
      {
        provider: "pi",
        id: "shared-model",
        label: "Runtime Label",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [
            {
              id: "shared-model",
              label: "Profile Label",
            },
            {
              id: "profile-model",
              label: "Profile Model",
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "shared-model",
        label: "Profile Label",
      },
      {
        provider: "pi",
        id: "profile-model",
        label: "Profile Model",
      },
    ]);
  });

  test("additional models merge onto profile replacement models", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-pro",
        label: "Runtime Pro",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [
            {
              id: "profile-curated",
              label: "Profile Curated",
            },
          ],
          additionalModels: [
            {
              id: "profile-extra",
              label: "Profile Extra",
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models.map((model) => model.id)).toEqual(["profile-curated", "profile-extra"]);
  });

  test("additional models override matching runtime models in place", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "shared-model",
        label: "Runtime Label",
        description: "Runtime description",
        metadata: {
          source: "runtime",
        },
      },
      {
        provider: "pi",
        id: "runtime-only",
        label: "Runtime Only",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          additionalModels: [
            {
              id: "shared-model",
              label: "Profile Label",
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "shared-model",
        label: "Profile Label",
        description: "Runtime description",
        metadata: {
          source: "runtime",
        },
      },
      {
        provider: "pi",
        id: "runtime-only",
        label: "Runtime Only",
      },
    ]);
  });

  test("additional model default overrides runtime default", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
      {
        provider: "pi",
        id: "runtime-other",
        label: "Runtime Other",
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          additionalModels: [
            {
              id: "profile-default",
              label: "Profile Default",
              isDefault: true,
            },
          ],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: false,
      },
      {
        provider: "pi",
        id: "runtime-other",
        label: "Runtime Other",
        isDefault: false,
      },
      {
        provider: "pi",
        id: "profile-default",
        label: "Profile Default",
        isDefault: true,
      },
    ]);
  });

  test("no profile models — runtime models returned as-is", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);

    const registry = buildProviderRegistry(logger);
    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      {
        provider: "pi",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);
  });

  test("built-in createClient().fetchCatalog() honors profile model replacement (issue #579)", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [
            {
              id: "profile-fast",
              label: "Profile Fast",
              isDefault: true,
            },
          ],
        },
      },
    });

    const client = registry.pi.createClient(logger);
    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["profile-fast"]);
    expect(catalog.models.find((model) => model.isDefault)?.id).toBe("profile-fast");
  });

  test("built-in createClient().fetchCatalog() honors additionalModels default (issue #579)", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "runtime-default",
        label: "Runtime Default",
        isDefault: true,
      },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          additionalModels: [
            {
              id: "profile-default",
              label: "Profile Default",
              isDefault: true,
            },
          ],
        },
      },
    });

    const client = registry.pi.createClient(logger);
    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    const defaultModel = catalog.models.find((model) => model.isDefault) ?? catalog.models[0];
    expect(defaultModel?.id).toBe("profile-default");
  });

  test("explicit additional models override hidden compatibility entries", async () => {
    mockState.runtimeModels.set("pi", [
      {
        provider: "pi",
        id: "claude-fable-5[1m]",
        label: "Fable 5",
        isSelectable: false,
      },
    ]);
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          additionalModels: [{ id: "claude-fable-5[1m]", label: "Gateway Fable 5" }],
        },
      },
    });

    const { models } = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/registry-models",
      force: false,
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "claude-fable-5[1m]",
        label: "Gateway Fable 5",
        isSelectable: true,
      }),
    ]);
  });
});

describe("fetchCatalog", () => {
  test("returns merged models and modes from fetchCatalog", async () => {
    mockState.runtimeModels.set("pi", [
      { provider: "pi", id: "codex-runtime", label: "Codex Runtime" },
    ]);

    const registry = buildProviderRegistry(logger);
    const catalog = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/catalog",
      force: false,
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["codex-runtime"]);
    expect(catalog.modes).toEqual([]);
  });

  test("replacement models skip runtime model discovery but preserve additionalModels", async () => {
    mockState.runtimeModels.set("pi", [
      { provider: "pi", id: "codex-runtime", label: "Codex Runtime" },
    ]);

    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [{ id: "profile-model", label: "Profile Model" }],
          additionalModels: [{ id: "extra-model", label: "Extra Model" }],
        },
      },
    });

    const catalog = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/catalog",
      force: false,
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["profile-model", "extra-model"]);
  });

  test("replacement models still resolve the provider's capability-aware default mode", async () => {
    const resolveDefaultModeId = vi.fn(async () => "default");
    const injectedClient = {
      provider: "mock",
      capabilities: {},
      resolveDefaultModeId,
      isAvailable: vi.fn(async () => true),
    } satisfies Partial<AgentClient> as AgentClient;
    const registry = buildProviderRegistry(logger, {
      isDev: true,
      providerOverrides: {
        mock: { models: [{ id: "profile-model", label: "Profile Model" }] },
      },
    });

    const catalog = await registry.mock.fetchCatalog(
      { scope: "workspace", cwd: "/tmp/catalog", force: false },
      injectedClient,
    );

    expect(catalog.defaultModeId).toBe("default");
    expect(resolveDefaultModeId).toHaveBeenCalledWith({
      config: { provider: "mock", cwd: "/tmp/catalog" },
    });
  });

  test("additionalModels can override replacement model fields", async () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        pi: {
          models: [{ id: "shared-model", label: "Profile Label" }],
          additionalModels: [{ id: "shared-model", label: "Additional Label" }],
        },
      },
    });

    const catalog = await registry.pi.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/catalog",
      force: false,
    });

    expect(catalog.models).toEqual([
      {
        provider: "pi",
        id: "shared-model",
        label: "Additional Label",
      },
    ]);
  });

  test("uses injected client instead of base client when provided", async () => {
    const injectedModels: AgentModelDefinition[] = [
      { provider: "pi", id: "injected-model", label: "Injected Model" },
    ];
    const injectedModes: AgentMode[] = [{ id: "agent", label: "Agent" }];
    const injectedClient = {
      provider: "pi",
      capabilities: {},
      fetchCatalog: vi.fn(async () => ({ models: injectedModels, modes: injectedModes })),
      isAvailable: vi.fn(async () => true),
    } satisfies Partial<AgentClient> as AgentClient;

    const registry = buildProviderRegistry(logger);
    const catalog = await registry.pi.fetchCatalog(
      { cwd: "/tmp/catalog", force: false },
      injectedClient,
    );

    expect(injectedClient.fetchCatalog).toHaveBeenCalledTimes(1);
    expect(catalog.models.map((model) => model.id)).toEqual(["injected-model"]);
    expect(catalog.modes).toEqual(injectedModes);
  });

  test("uses injected client fetchCatalog when available", async () => {
    const injectedClient = {
      provider: "pi",
      capabilities: {},
      fetchCatalog: vi.fn(async () => ({
        models: [{ provider: "pi", id: "catalog-model", label: "Catalog Model" }],
        modes: [{ id: "ask", label: "Ask" }],
      })),
      isAvailable: vi.fn(async () => true),
    } satisfies Partial<AgentClient> as AgentClient;

    const registry = buildProviderRegistry(logger);
    const catalog = await registry.pi.fetchCatalog(
      { cwd: "/tmp/catalog", force: false },
      injectedClient,
    );

    expect(injectedClient.fetchCatalog).toHaveBeenCalledTimes(1);
    expect(catalog.models.map((model) => model.id)).toEqual(["catalog-model"]);
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["ask"]);
  });
});
