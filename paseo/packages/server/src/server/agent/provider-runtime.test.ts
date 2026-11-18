import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createAgentProviderRuntime } from "./provider-runtime.js";

describe("agent provider runtime", () => {
  test("owns the snapshot manager and shuts it down once", async () => {
    const runtime = await createAgentProviderRuntime({
      paseoHome: "/tmp/paseo-provider-runtime-test",
      logger: createTestLogger(),
      snapshotManager: {},
    });
    const shutdown = vi.spyOn(runtime.snapshotManager, "shutdown");

    expect(runtime.snapshotManager.getAgentManagerProviderState().clients.pi).toBeDefined();
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
