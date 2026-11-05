import { Platform } from "react-native";
import { create } from "zustand";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { getNetworkProbe } from "./probe";
import {
  runNetworkTests,
  type NetworkTestClient,
  type NetworkTestHost,
  type NetworkTestRun,
  type NetworkTestStep,
} from "./run-tests";

const MAX_RUNS = 10;

interface NetworkTestState {
  /** Newest first; kept for the session only. */
  runs: NetworkTestRun[];
  running: boolean;
  step: NetworkTestStep | null;
}

export const useNetworkTestStore = create<NetworkTestState>(() => ({
  runs: [],
  running: false,
  step: null,
}));

export function collectNetworkTestHosts(): NetworkTestHost[] {
  const store = getHostRuntimeStore();
  const labels = new Map(store.getHosts().map((host) => [host.serverId, host.label]));
  const sessions = useSessionStore.getState().sessions;
  return store.listServerIds().map((serverId) => {
    const snapshot = store.getSnapshot(serverId);
    const features = sessions[serverId]?.serverInfo?.features;
    return {
      serverId,
      label: labels.get(serverId) ?? sessions[serverId]?.serverInfo?.hostname ?? serverId,
      connection: snapshot?.activeConnection ?? null,
      client: (store.getClient(serverId) as NetworkTestClient | null) ?? null,
      online: snapshot?.connectionStatus === "online",
      networkDiagnostics: features?.networkDiagnostics === true,
    };
  });
}

export async function startNetworkTestRun(): Promise<NetworkTestRun | null> {
  if (useNetworkTestStore.getState().running) return null;
  useNetworkTestStore.setState({ running: true, step: "internet" });
  try {
    const run = await runNetworkTests({
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
      isWeb: Platform.OS === "web",
      probe: getNetworkProbe(),
      hosts: collectNetworkTestHosts(),
      onProgress: (step) => useNetworkTestStore.setState({ step }),
    });
    useNetworkTestStore.setState((state) => ({
      runs: [run, ...state.runs].slice(0, MAX_RUNS),
    }));
    return run;
  } finally {
    useNetworkTestStore.setState({ running: false, step: null });
  }
}
