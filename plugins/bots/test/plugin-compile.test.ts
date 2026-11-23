/**
 * Compiles the bots plugin with Paseo's real plugin compiler (paseo/packages/server/src/server/plugins/compiler.ts),
 * the same code the daemon runs when it loads the plugin. tsx runs modules the host refuses, so the rest of this suite
 * passed on both 18 Nov load failures (an optchat type import that reached pi's type graph, and a server module that
 * imported ../../bot-dm/). If this test fails, the plugin will not load at daemon start.
 */
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compilePlugin } from "../../../paseo/packages/server/src/server/plugins/compiler.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Paseo's plugin compiler builds the bots plugin (client and server bundles)", async () => {
  const out = await compilePlugin({
    client: join(ROOT, "index.client.tsx"),
    server: join(ROOT, "index.server.ts"),
  });
  assert.ok((out.serverBundle?.length ?? 0) > 10_000, "server bundle is empty");
  assert.ok((out.clientBundle?.length ?? 0) > 10_000, "client bundle is empty");
});
