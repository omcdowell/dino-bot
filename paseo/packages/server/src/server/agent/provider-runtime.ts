import type { Logger } from "pino";

import {
  ProviderSnapshotManager,
  type ProviderSnapshotManagerOptions,
} from "./provider-snapshot-manager.js";
import { OpenCodeBridge } from "./providers/opencode/bridge.js";
import type { PaseoToolCatalog } from "./tools/types.js";

export interface AgentProviderRuntime {
  snapshotManager: ProviderSnapshotManager;
  setPaseoToolCatalog(catalog: PaseoToolCatalog | null): void;
  shutdown(): Promise<void>;
}

interface CreateAgentProviderRuntimeOptions {
  paseoHome: string;
  logger: Logger;
  snapshotManager: Omit<ProviderSnapshotManagerOptions, "logger" | "openCodeBridge">;
}

export async function createAgentProviderRuntime(
  options: CreateAgentProviderRuntimeOptions,
): Promise<AgentProviderRuntime> {
  // DinoBot: no OpenCode loopback listener when opencode is off in config (re-enabling it needs a
  // restart for Paseo's tools inside OpenCode; OpenCode itself runs without the bridge).
  const bridge =
    options.snapshotManager.providerOverrides?.opencode?.enabled === false
      ? null
      : new OpenCodeBridge({ paseoHome: options.paseoHome, logger: options.logger });
  try {
    await bridge?.start();
    const snapshotManager = new ProviderSnapshotManager({
      ...options.snapshotManager,
      logger: options.logger.child({ module: "provider-snapshot-manager" }),
      openCodeBridge: bridge ?? undefined,
    });
    let shutdownPromise: Promise<void> | null = null;
    return {
      snapshotManager,
      setPaseoToolCatalog: (catalog) => bridge?.setManifestCatalog(catalog),
      shutdown: () => {
        shutdownPromise ??= shutdownProviderRuntime(snapshotManager, bridge);
        return shutdownPromise;
      },
    };
  } catch (error) {
    await bridge?.close().catch(() => undefined);
    throw error;
  }
}

async function shutdownProviderRuntime(
  snapshotManager: ProviderSnapshotManager,
  bridge: OpenCodeBridge | null,
): Promise<void> {
  try {
    await snapshotManager.shutdown();
  } finally {
    await bridge?.close();
  }
}
