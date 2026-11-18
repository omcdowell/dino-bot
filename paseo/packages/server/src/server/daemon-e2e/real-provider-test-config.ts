import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Logger } from "pino";

import type { AgentClient, AgentProvider, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";

export const realProviders = ["pi"] as const;
export type RealProvider = (typeof realProviders)[number];
export type RealProviderConfig = Pick<
  AgentSessionConfig,
  "provider" | "model" | "modeId" | "thinkingOptionId"
>;

const PI_AUTH_CONFIG_PATH = join(homedir(), ".pi", "agent", "auth.json");
const CODEX_AUTH_CONFIG_PATH = join(homedir(), ".codex", "auth.json");
const PI_OPENROUTER_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";
const PI_CODEX_REAL_TEST_MODEL = "openai-codex/gpt-5.4";

const availabilityCache = new Map<RealProvider, Promise<boolean>>();

export function getRealProviderConfig(provider: RealProvider): RealProviderConfig {
  switch (provider) {
    case "pi":
      return {
        provider,
        model: getPiRealTestModel(),
        thinkingOptionId: "medium",
      };
  }
}

export function getRealProviderRuntimeSettings(_provider: RealProvider): ProviderRuntimeSettings {
  if (hasCodexAuthTokens()) {
    return {
      env: {
        // Clear stale shell-level keys so the local CLI auth stores win.
        OPENAI_API_KEY: "",
      },
    };
  }
  const apiKey = getOpenRouterApiKeyOrNull();
  if (apiKey) {
    return {
      env: {
        OPENROUTER_API_KEY: apiKey,
        OPENAI_API_KEY: "",
      },
    };
  }
  return {};
}

export function createRealProviderClient(provider: RealProvider, logger: Logger): AgentClient {
  const runtimeSettings = getRealProviderRuntimeSettings(provider);
  switch (provider) {
    case "pi":
      return new PiRpcAgentClient({ logger, runtimeSettings });
  }
}

export function createRealProviderClients(
  providers: readonly RealProvider[],
  logger: Logger,
): Partial<Record<AgentProvider, AgentClient>> {
  return Object.fromEntries(
    providers.map((provider) => [provider, createRealProviderClient(provider, logger)]),
  );
}

export function canRunRealProvider(provider: RealProvider): Promise<boolean> {
  const cached = availabilityCache.get(provider);
  if (cached) {
    return cached;
  }

  const availability = (async () => {
    return await isCommandAvailable(getProviderBinary(provider));
  })();

  availabilityCache.set(provider, availability);
  return availability;
}

function getPiRealTestModel(): string {
  const configured = process.env.PI_REAL_TEST_MODEL?.trim();
  if (configured) {
    return configured;
  }
  return hasCodexAuthTokens() ? PI_CODEX_REAL_TEST_MODEL : PI_OPENROUTER_REAL_TEST_MODEL;
}

function getOpenRouterApiKeyOrNull(): string | null {
  const value = readPiOpenRouterApiKey() ?? process.env.OPENROUTER_API_KEY?.trim();
  return value && value.length > 0 ? value : null;
}

function readPiOpenRouterApiKey(): string | null {
  const auth = readJsonFile(PI_AUTH_CONFIG_PATH);
  const value =
    auth && typeof auth === "object" && "openrouter" in auth ? auth.openrouter : undefined;
  if (!value || typeof value !== "object" || value === null || !("key" in value)) {
    return null;
  }
  return typeof value.key === "string" && value.key.trim().length > 0 ? value.key.trim() : null;
}

function hasCodexAuthTokens(): boolean {
  const auth = readJsonFile(CODEX_AUTH_CONFIG_PATH);
  if (!auth || typeof auth !== "object" || !("tokens" in auth)) {
    return false;
  }
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== "object") {
    return false;
  }
  return (
    (typeof tokens.access_token === "string" && tokens.access_token.length > 0) ||
    (typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0)
  );
}

function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function getProviderBinary(_provider: RealProvider): string {
  return process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi";
}
