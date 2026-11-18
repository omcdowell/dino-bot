import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonConfigStore } from "../../server/daemon-config-store.js";
import { applyTerminalAgentHookSetting } from "./terminal-agent-hook-setting.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function createInstallEnv(root: string) {
  return {
    env: {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    },
    homeDir: join(root, "home"),
  };
}

function hookPaths(root: string) {
  return {
    claude: join(root, "claude", "settings.json"),
  };
}

function createStore(paseoHome: string, enableTerminalAgentHooks: boolean): DaemonConfigStore {
  return new DaemonConfigStore(
    paseoHome,
    {
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks,
      appendSystemPrompt: "",
    },
    undefined,
  );
}

describe("applyTerminalAgentHookSetting", () => {
  it("leaves agent configs untouched when the setting is disabled", () => {
    const root = createTempDir("paseo-hook-setting-");
    const store = createStore(createTempDir("paseo-hook-setting-home-"), false);

    applyTerminalAgentHookSetting({ store, install: createInstallEnv(root) });

    const paths = hookPaths(root);
    expect(existsSync(paths.claude)).toBe(false);
  });

  it("installs agent hooks when the setting is enabled", () => {
    const root = createTempDir("paseo-hook-setting-");
    const store = createStore(createTempDir("paseo-hook-setting-home-"), true);

    applyTerminalAgentHookSetting({ store, install: createInstallEnv(root) });

    const paths = hookPaths(root);
    expect(existsSync(paths.claude)).toBe(true);
  });

  it("installs on enable and removes hooks on disable when toggled live", () => {
    const root = createTempDir("paseo-hook-setting-");
    const store = createStore(createTempDir("paseo-hook-setting-home-"), false);
    const paths = hookPaths(root);

    applyTerminalAgentHookSetting({ store, install: createInstallEnv(root) });
    expect(existsSync(paths.claude)).toBe(false);

    store.patch({ enableTerminalAgentHooks: true });
    expect(readFileSync(paths.claude, "utf8")).toContain("paseo");

    store.patch({ enableTerminalAgentHooks: false });
    expect(readFileSync(paths.claude, "utf8")).not.toContain("paseo");
  });
});
