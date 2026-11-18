import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../test-utils/test-logger.js";

import { validateProviderOptions } from "./provider-options.js";
import { buildProviderRegistry } from "./provider-registry.js";

const hubPolicy = {
  preapproved: [{ kind: "mcp" as const, server: "hub", tool: "finish_execution" }],
};

// A stand-in provider schema (the Claude SDK provider and its schema were deleted).
const FakeProviderOptionsSchema = z
  .object({
    extraArgs: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
    sandbox: z
      .object({
        network: z.object({ allowLocalBinding: z.boolean().optional() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

describe("validateProviderOptions", () => {
  test.each([true, 42, ["x"]])("rejects invalid extra argument values: %j", (value) => {
    expect(() =>
      validateProviderOptions("fake", FakeProviderOptionsSchema, {
        extraArgs: { chrome: value },
      }),
    ).toThrow("providerOptions.extraArgs.chrome");
  });

  test("reports the exact invalid option path", () => {
    expect(() =>
      validateProviderOptions("fake", FakeProviderOptionsSchema, {
        sandbox: { network: { allowLocalBinding: "yes" } },
      }),
    ).toThrow("providerOptions.sandbox.network.allowLocalBinding");
  });

  test("rejects unknown keys with the provider id", () => {
    expect(() => validateProviderOptions("fake", FakeProviderOptionsSchema, { hooks: {} })).toThrow(
      "Invalid providerOptions for 'fake'",
    );
  });
});

describe("exact MCP preapproval mappings", () => {
  test("unsupported providers fail closed with an unattended-execution error", () => {
    const registry = buildProviderRegistry(createTestLogger());
    expect(() =>
      registry.pi.applyToolPolicy(
        {
          provider: "pi",
          cwd: "/tmp",
          mcpServers: { hub: { type: "http", url: "http://127.0.0.1/hub" } },
        },
        hubPolicy,
      ),
    ).toThrow("cannot preapprove exact MCP tools for unattended execution");
  });
});

describe("configured provider options", () => {
  test.each(["options", "params"] as const)(
    "Pi imports read sessionDir from config %s",
    async (key) => {
      const dir = mkdtempSync(join(tmpdir(), "provider-options-import-"));
      try {
        const file = join(dir, "native.jsonl");
        writeFileSync(
          file,
          JSON.stringify({
            type: "session",
            version: 3,
            id: "native",
            cwd: "/tmp/options-project",
          }) + "\n",
        );
        const logger = createTestLogger();
        const registry = buildProviderRegistry(logger, {
          providerOverrides: { pi: { [key]: { sessionDir: dir } } },
        });
        const sessions = await registry.pi.createClient(logger).listImportableSessions!({
          cwd: "/tmp/options-project",
        });
        expect(sessions.map((session) => session.providerHandleId)).toEqual([file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("a provider without option handling ignores the record", async () => {
    const logger = createTestLogger();
    const registry = buildProviderRegistry(logger, {
      isDev: true,
      providerOverrides: { mock: { options: { arbitrary: { base: true } } } },
    });
    const session = await registry.mock
      .createClient(logger)
      .createSession({ provider: "mock", cwd: "/tmp", providerOptions: { more: [1] } });
    expect(session.provider).toBe("mock");
    await session.close();
  });
});
