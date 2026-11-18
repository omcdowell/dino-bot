import type { Logger } from "pino";

import {
  ProviderSnapshotManager,
  type ProviderSnapshotManagerOptions,
} from "./provider-snapshot-manager.js";

export interface AgentProviderRuntime {
  snapshotManager: ProviderSnapshotManager;
  shutdown(): Promise<void>;
}

interface CreateAgentProviderRuntimeOptions {
  paseoHome: string;
  logger: Logger;
  snapshotManager: Omit<ProviderSnapshotManagerOptions, "logger">;
}

export async function createAgentProviderRuntime(
  options: CreateAgentProviderRuntimeOptions,
): Promise<AgentProviderRuntime> {
  const snapshotManager = new ProviderSnapshotManager({
    ...options.snapshotManager,
    logger: options.logger.child({ module: "provider-snapshot-manager" }),
  });
  let shutdownPromise: Promise<void> | null = null;
  return {
    snapshotManager,
    shutdown: () => {
      shutdownPromise ??= snapshotManager.shutdown();
      return shutdownPromise;
    },
  };
}
