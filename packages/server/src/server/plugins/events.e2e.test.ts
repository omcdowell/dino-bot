import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("plugin server events reach only the apps subscribed to plugin.event", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "events-plugin-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "events-test",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const poke = defineRpc({ name: "events-test.poke", input: z.object({ n: z.number(), name: z.string().optional() }), output: z.object({ ok: z.boolean(), error: z.string().optional() }) });
export default function(server) {
  server.handle(poke, ({ n, name }) => {
    try {
      server.emit(name ?? "changed", { n });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  return () => {};
}`,
  );
  const daemon = await createTestPaseoDaemon();
  onTestFinished(() => daemon.close());
  const listening = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const quiet = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  onTestFinished(() => listening.close());
  onTestFinished(() => quiet.close());
  await listening.connect();
  await quiet.connect();
  expect(listening.getLastServerInfoMessage()?.features?.pluginEvents).toBe(true);
  await listening.patchDaemonConfig({ pluginsEnabled: true });
  await listening.installDirectoryPlugin(directory);

  const heard: unknown[] = [];
  const overheard: unknown[] = [];
  listening.on("plugin.event", (message) => heard.push(message.payload));
  quiet.on("plugin.event", (message) => overheard.push(message.payload));
  await quiet.observeEvents(["status.plugin_catalog_changed"]).ready;
  const observation = listening.observeEvents(["plugin.event"]);
  await observation.ready;

  expect(await quiet.invokePluginRpc("events-test", "events-test.poke", { n: 1 })).toEqual({
    ok: true,
  });
  await expect
    .poll(() => heard)
    .toEqual([expect.objectContaining({ pluginId: "events-test", name: "changed", data: { n: 1 } })]);
  expect(
    await quiet.invokePluginRpc("events-test", "events-test.poke", { n: 2, name: "Bad Name" }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("Invalid plugin event name") });

  await observation.release();
  await quiet.invokePluginRpc("events-test", "events-test.poke", { n: 3 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(heard).toHaveLength(1);
  expect(overheard).toEqual([]);
}, 60_000);
