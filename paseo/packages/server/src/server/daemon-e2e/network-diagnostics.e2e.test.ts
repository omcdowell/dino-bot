import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test("the speed test moves the bytes both ways over the session socket", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, isDev: true });
  cleanups.push(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  cleanups.push(() => client.close());

  expect(client.getLastServerInfoMessage()?.features?.networkDiagnostics).toBe(true);
  const down = await client.runNetworkSpeedTest("down", 256 * 1024);
  expect(down.bytes).toBe(256 * 1024);
  expect(down.elapsedMs).toBeGreaterThan(0);
  const up = await client.runNetworkSpeedTest("up", 64 * 1024);
  expect(up.bytes).toBe(64 * 1024);
}, 30_000);
