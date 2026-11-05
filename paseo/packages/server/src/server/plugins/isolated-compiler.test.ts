import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIsolatedPluginCompiler,
  forkCompilerWorker,
  type PluginCompiler,
} from "./isolated-compiler.js";

const temporaryDirectories: string[] = [];
const compilers: PluginCompiler[] = [];

afterEach(async () => {
  for (const compiler of compilers.splice(0)) compiler.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function pluginWithServerEntry(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-isolated-compiler-"));
  temporaryDirectories.push(directory);
  const entry = path.join(directory, "index.server.ts");
  await writeFile(entry, source, "utf8");
  return entry;
}

function trackedCompiler(idleMs: number) {
  const children: ChildProcess[] = [];
  const compiler = createIsolatedPluginCompiler({
    idleMs,
    forkWorker: () => {
      const child = forkCompilerWorker();
      children.push(child);
      return child;
    },
  });
  compilers.push(compiler);
  return { compiler, children };
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("isolated plugin compiler", () => {
  it("compiles in a child process that exits once compiles stop", async () => {
    const { compiler, children } = trackedCompiler(200);
    const entry = await pluginWithServerEntry(
      "export default function contribute() { return () => undefined; }\n",
    );

    const first = await compiler.compile({ client: null, server: entry });
    const second = await compiler.compile({ client: null, server: entry });

    expect(first.clientBundle).toBeNull();
    expect(first.serverBundle).toContain("contribute");
    expect(second).toEqual(first);
    expect(children).toHaveLength(1);

    await exited(children[0]!);

    const third = await compiler.compile({ client: null, server: entry });
    expect(third).toEqual(first);
    expect(children).toHaveLength(2);
  }, 30_000);

  it("passes compile errors through with their message", async () => {
    const { compiler } = trackedCompiler(200);
    const entry = await pluginWithServerEntry(
      'import { useState } from "react";\nexport default function contribute() { useState; return () => undefined; }\n',
    );

    await expect(compiler.compile({ client: null, server: entry })).rejects.toThrow(
      "client-only module cannot be imported into the plugin server bundle",
    );
  }, 30_000);

  it("rejects pending compiles when the child dies", async () => {
    const { compiler, children } = trackedCompiler(10_000);
    const entry = await pluginWithServerEntry(
      "export default function contribute() { return () => undefined; }\n",
    );

    const compiling = compiler.compile({ client: null, server: entry });
    children[0]!.kill("SIGKILL");

    await expect(compiling).rejects.toThrow("Plugin compiler exited");
  }, 30_000);
});
