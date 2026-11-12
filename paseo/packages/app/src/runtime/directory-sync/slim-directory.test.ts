import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { DirectorySync, PARENT_AGENT_LABEL, SLIM_PAGE_LIMIT } from "./index";
import { subscriptionFixture } from "../subscription-fixture";

type AgentFetchResult = Awaited<ReturnType<DaemonClient["fetchAgents"]>>;
type WorkspaceFetchResult = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;

const FULL_CAPS = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

function agentPayload(id: string, extra: Partial<AgentSnapshotPayload> = {}): AgentSnapshotPayload {
  return {
    id,
    provider: "codex",
    cwd: "/repo",
    model: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: FULL_CAPS,
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: { provider: "codex", sessionId: `s-${id}` },
    title: id,
    labels: {},
    ...extra,
  };
}

function slimPayload(id: string, extra: Partial<AgentSnapshotPayload> = {}): AgentSnapshotPayload {
  return {
    ...agentPayload(id, extra),
    capabilities: {
      ...FULL_CAPS,
      supportsStreaming: false,
      supportsToolInvocations: false,
    },
    persistence: null,
    slim: true,
  };
}

function entry(agent: AgentSnapshotPayload): AgentFetchResult["entries"][number] {
  return { agent, project: null as never };
}

class SlimClient {
  agentCalls: Array<Record<string, unknown>> = [];
  workspaceCalls: Array<Record<string, unknown>> = [];
  agentPages: AgentFetchResult[] = [];
  fetchAgentCalls: string[] = [];
  supportsBackgroundWorkspaces() {
    return false;
  }
  async fetchAgents(options: Record<string, unknown>): Promise<AgentFetchResult> {
    this.agentCalls.push(options);
    return (
      this.agentPages.shift() ?? {
        requestId: "a",
        entries: [],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      }
    );
  }
  async fetchWorkspaces(options: Record<string, unknown>): Promise<WorkspaceFetchResult> {
    this.workspaceCalls.push(options);
    return {
      requestId: "w",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }
  async fetchAgent({ agentId }: { agentId: string }) {
    this.fetchAgentCalls.push(agentId);
    return { agent: agentPayload(agentId), project: null };
  }
  async listProjects() {
    return { requestId: "p", projects: [] };
  }
  observeAgents(options: Record<string, unknown>) {
    return subscriptionFixture(this.fetchAgents({ ...options, subscribe: {} }), () => () => {});
  }
  observeWorkspaces(options: Record<string, unknown>) {
    return subscriptionFixture(this.fetchWorkspaces(options), () => () => {});
  }
  observeEvents() {
    return subscriptionFixture(Promise.resolve({ events: [] }), () => () => {});
  }
  getLastServerInfoMessage() {
    return null;
  }
  on() {
    return () => {};
  }
}

const serverIds = new Set<string>();
afterEach(() => {
  for (const serverId of serverIds) useSessionStore.getState().clearSession(serverId);
  serverIds.clear();
});

function setup(serverId: string, slimDirectory: boolean) {
  serverIds.add(serverId);
  const client = new SlimClient();
  const directory = new DirectorySync(serverId, {
    onAgentStoppedRunning: () => undefined,
    markAgentLoading: () => undefined,
    markAgentReady: () => undefined,
    markAgentError: () => undefined,
  });
  const store = useSessionStore.getState();
  store.initializeSession(serverId, client as unknown as DaemonClient, 1);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: "test",
    features: {
      directorySync: true,
      ...(slimDirectory ? { slimDirectory: true } : {}),
    },
  });
  directory.connectionChanged({
    client: client as unknown as DaemonClient,
    status: "online",
    source: { clientGeneration: 1, connectionEpoch: 1 },
  });
  return { client, directory };
}

const agentsOf = (serverId: string) => useSessionStore.getState().sessions[serverId]!.agents;

describe("slim directory (B3)", () => {
  it("asks a slim-capable host for one slim priority page and loads the rest on scroll", async () => {
    const { client, directory } = setup("slim-host", true);
    client.agentPages.push(
      {
        requestId: "a",
        entries: [entry(slimPayload("a1"))],
        pageInfo: { hasMore: true, nextCursor: "c1", prevCursor: null },
        sync: { generation: "g", headSeq: 3, mode: "snapshot", removals: [] },
      },
      {
        requestId: "a",
        entries: [entry(slimPayload("a2"))],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: "c1" },
      },
    );
    await directory.refreshAgents({ subscribe: {} });
    expect(client.agentCalls).toHaveLength(1);
    expect(client.agentCalls[0]).toMatchObject({
      slim: true,
      omitIdleDelegated: true,
      page: { limit: SLIM_PAGE_LIMIT },
      sync: {},
    });
    expect([...agentsOf("slim-host").keys()]).toEqual(["a1"]);
    expect(agentsOf("slim-host").get("a1")?.slim).toBe(true);
    expect(directory.hasMoreAgents()).toBe(true);

    await directory.loadMoreAgents();
    expect(client.agentCalls[1]).toMatchObject({
      slim: true,
      omitIdleDelegated: true,
      page: { limit: SLIM_PAGE_LIMIT, cursor: "c1" },
    });
    expect(client.agentCalls[1]?.sync).toBeUndefined();
    expect([...agentsOf("slim-host").keys()].sort()).toEqual(["a1", "a2"]);
    expect(directory.hasMoreAgents()).toBe(false);
  });

  it("keeps the old full, unpaged request for hosts without slimDirectory", async () => {
    const { client, directory } = setup("old-host", false);
    await directory.refreshAgents({ subscribe: {} });
    expect(client.agentCalls[0]?.slim).toBeUndefined();
    expect(client.agentCalls[0]?.page).toEqual({ limit: 200 });
    expect(client.workspaceCalls[0]?.slim).toBeUndefined();
    expect(directory.hasMoreAgents()).toBe(false);
  });

  it("a slim row never downgrades a full row, and opening a slim agent loads the full row and its children", async () => {
    const { client, directory } = setup("merge-host", true);
    client.agentPages.push({
      requestId: "a",
      entries: [entry(agentPayload("full")), entry(slimPayload("thin"))],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await directory.refreshAgents({ subscribe: {} });
    client.agentPages.push({
      requestId: "a",
      entries: [
        entry(
          slimPayload("full", {
            title: "renamed",
            updatedAt: "2026-08-27T00:00:00.000Z",
          }),
        ),
        entry(slimPayload("thin")),
      ],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await directory.refreshAgents({ subscribe: {} });
    const full = agentsOf("merge-host").get("full")!;
    expect(full.title).toBe("renamed");
    expect(full.slim).toBeUndefined();
    expect(full.capabilities).toEqual(expect.objectContaining(FULL_CAPS));
    expect(full.persistence).toEqual({
      provider: "codex",
      sessionId: "s-full",
    });

    client.agentPages.push({
      requestId: "a",
      entries: [entry(slimPayload("child", { labels: { [PARENT_AGENT_LABEL]: "thin" } }))],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await directory.prepareAgentRoute("thin");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.fetchAgentCalls).toEqual(["thin"]);
    const thin = agentsOf("merge-host").get("thin")!;
    expect(thin.slim).toBeUndefined();
    expect(thin.capabilities.supportsStreaming).toBe(true);
    const childCall = client.agentCalls.at(-1)!;
    expect(childCall).toMatchObject({
      slim: true,
      filter: { labels: { [PARENT_AGENT_LABEL]: "thin" } },
    });
    expect(agentsOf("merge-host").get("child")?.parentAgentId).toBe("thin");
  });
});
