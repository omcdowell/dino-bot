import type { PluginClientOpenPanelOptions } from "@getpaseo/plugin/client";
import { DMS_PANEL_ID } from "./dms-format";

/**
 * DMs tab on by default for new bots (owner, 15 Nov: a new bot's Explorer showed only Files and
 * Changes). The plugin API has no "default panel" option, so the first time a NEW bot's chat is
 * opened from the Bots sidebar on this client, the DMs panel is opened once in its workspace's
 * Explorer. "New" = not in the bot list this client saw when the feature first ran: existing bots are
 * left alone (no backfill), and a bot is claimed once, so closing the tab later sticks.
 * Per client (localStorage), like the Explorer layout itself.
 */

const STORAGE_KEY = "paseo-bots.dms-panel.seen";

export interface SeenStore {
  /** Bot ids seen so far; null before the first seed. */
  read(): string[] | null;
  write(ids: string[]): void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function storageSeenStore(storage: StorageLike | undefined): SeenStore {
  return {
    read() {
      try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
      } catch {
        return null;
      }
    },
    write(ids) {
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(ids));
      } catch {
        // no storage: the feature just does nothing
      }
    },
  };
}

export function memorySeenStore(): SeenStore {
  let ids: string[] | null = null;
  return { read: () => ids, write: (next) => void (ids = [...next]) };
}

function browserStorage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

let defaultStore: SeenStore | null = null;
export function seenStore(): SeenStore {
  return (defaultStore ??= storageSeenStore(browserStorage()));
}

/** First run only: every bot in the list counts as old. An empty list (still loading) does not seed. */
export function seedSeenBots(store: SeenStore, botIds: readonly string[]): void {
  if (store.read() !== null || botIds.length === 0) return;
  store.write([...botIds]);
}

/** True once for a bot that was not there at the seed; it is then remembered. */
export function claimNewBot(store: SeenStore, botId: string): boolean {
  const seen = store.read();
  if (seen === null || seen.includes(botId)) return false;
  store.write([...seen, botId]);
  return true;
}

export interface DmsDefaultDeps {
  workspaceIdOf(agentId: string): Promise<string | null>;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
  wait(ms: number): Promise<void>;
}

/**
 * Opens the DMs panel in the Explorer of the agent's workspace. Waits first so the chat's own
 * navigation lands; retries while the app does not know the (just made) workspace yet. The app keeps
 * focus in the chat pane (the Explorer tab shown becomes DMs).
 */
export async function openDmsPanelForAgent(
  agentId: string,
  deps: DmsDefaultDeps,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 1000;
  for (let i = 0; i < attempts; i++) {
    await deps.wait(delayMs);
    let workspaceId: string | null = null;
    try {
      workspaceId = await deps.workspaceIdOf(agentId);
    } catch {
      continue;
    }
    if (!workspaceId) continue;
    try {
      deps.openPanel(DMS_PANEL_ID, { workspaceId, location: "explorer" });
      return true;
    } catch {
      // workspace not in the app's state yet
    }
  }
  return false;
}

/** Set from contribute(): the client's openPanel and the host API (for the agent's workspace). */
let liveDeps: DmsDefaultDeps | null = null;

interface AgentRefApi {
  agents: { ref(id: string): { workspaceId: string | null; refresh(): Promise<unknown> } };
}

export function setDmsDefaultClient(client: {
  openPanel?: (id: string, options: PluginClientOpenPanelOptions) => void;
  paseo?: unknown;
}): void {
  const paseo = client.paseo as AgentRefApi | undefined;
  if (!client.openPanel || !paseo?.agents?.ref) {
    liveDeps = null;
    return;
  }
  const openPanel = client.openPanel.bind(client);
  liveDeps = {
    openPanel,
    workspaceIdOf: async (agentId) => {
      const ref = paseo.agents.ref(agentId);
      await ref.refresh();
      return ref.workspaceId;
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Sidebar hook after a bot's chat opened: a new bot gets its DMs tab once. */
export function maybeOpenDmsForNewBot(botId: string, agentId: string): void {
  if (!liveDeps || !claimNewBot(seenStore(), botId)) return;
  void openDmsPanelForAgent(agentId, liveDeps);
}
