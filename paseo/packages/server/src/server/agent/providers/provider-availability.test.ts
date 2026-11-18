import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentProvider } from "../agent-sdk-types.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";

import { PiRpcAgentClient } from "./pi/agent.js";

const originalEnv = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isolatePathTo(dir: string): void {
  process.env.PATH = dir;
  if (process.platform === "win32") {
    process.env.PATHEXT = ".CMD";
  }
}

afterEach(() => {
  if (originalEnv.LOCALAPPDATA === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalEnv.LOCALAPPDATA;
  }
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("default provider availability", () => {
  test("Pi reports unavailable when the default command cannot be resolved", async () => {
    const binDir = makeTempDir("provider-availability-pi-");
    isolatePathTo(binDir);
    const client = new PiRpcAgentClient({ logger: createTestLogger() });

    await expect(client.isAvailable()).resolves.toBe(false);
  });

  test("AgentManager reports Pi unavailable without throwing", async () => {
    const binDir = makeTempDir("provider-availability-manager-bin-");
    isolatePathTo(binDir);
    const workdir = makeTempDir("provider-availability-manager-work-");
    const storage = new AgentStorage(join(workdir, "agents"), createTestLogger());
    const manager = new AgentManager({
      clients: {
        pi: new PiRpcAgentClient({ logger: createTestLogger() }),
      },
      registry: storage,
      logger: createTestLogger(),
    });

    await expect(manager.listProviderAvailability()).resolves.toEqual([
      {
        provider: "pi",
        available: false,
        error: null,
      },
    ]);
  });

  test("resumeAgentFromPersistence stops before provider spawn when Pi is unavailable", async () => {
    const binDir = makeTempDir("provider-availability-resume-bin-");
    isolatePathTo(binDir);
    const workdir = makeTempDir("provider-availability-resume-work-");
    const storage = new AgentStorage(join(workdir, "agents"), createTestLogger());
    const manager = new AgentManager({
      clients: {
        pi: new PiRpcAgentClient({ logger: createTestLogger() }),
      },
      registry: storage,
      logger: createTestLogger(),
    });

    await expect(
      manager.resumeAgentFromPersistence(
        {
          provider: "pi" as AgentProvider,
          sessionId: "missing-pi-session",
          metadata: {
            provider: "pi",
            cwd: workdir,
          },
        },
        { cwd: workdir },
      ),
    ).rejects.toThrow("Provider 'pi' is not available");
  });
});
