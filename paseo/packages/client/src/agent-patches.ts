import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

type AgentUpdateMessage = Extract<SessionOutboundMessage, { type: "agent_update" }>;
type AgentPatchMessage = Extract<SessionOutboundMessage, { type: "agent_patch" }>;
type UpsertPayload = Extract<AgentUpdateMessage["payload"], { kind: "upsert" }>;

interface Base {
  agent: UpsertPayload["agent"];
  project: UpsertPayload["project"];
  rev: number;
}

export type AgentPatchResult =
  | { kind: "update"; message: AgentUpdateMessage }
  /** The base is missing or older than the patch's: ask the daemon for the agent in full. */
  | { kind: "resync"; agentId: string; subscriptionId: string | undefined }
  /** A resync for this agent is already in flight: drop until its full upsert arrives. */
  | { kind: "drop" };

/**
 * Client side of agent_patches. Keeps the last full agent per subscription and turns each
 * agent_patch back into a full agent_update, so listeners, caches and plugins only ever see the
 * shapes they always had. One per physical socket: subscriptions, and so revisions, are too.
 */
export class AgentPatchExpander {
  private readonly bases = new Map<string, Base>();
  private readonly resyncing = new Set<string>();

  /** Feed every agent_update first; it becomes the base of the patches that follow. */
  observe(message: AgentUpdateMessage): void {
    const payload = message.payload;
    if (payload.kind === "remove") {
      const suffix = `\u0000${payload.agentId}`;
      // Deleting the entry being visited is safe while iterating a Map or Set.
      for (const key of this.bases.keys()) if (key.endsWith(suffix)) this.bases.delete(key);
      for (const key of this.resyncing) if (key.endsWith(suffix)) this.resyncing.delete(key);
      return;
    }
    if (payload.rev === undefined) return;
    const key = baseKey(payload.subscriptionId, payload.agent.id);
    this.bases.set(key, { agent: payload.agent, project: payload.project, rev: payload.rev });
    this.resyncing.delete(key);
  }

  expand(message: AgentPatchMessage): AgentPatchResult {
    const patch = message.payload;
    const key = baseKey(patch.subscriptionId, patch.agentId);
    if (this.resyncing.has(key)) return { kind: "drop" };
    const base = this.bases.get(key);
    if (!base || base.rev !== patch.baseRev) {
      this.bases.delete(key);
      this.resyncing.add(key);
      return { kind: "resync", agentId: patch.agentId, subscriptionId: patch.subscriptionId };
    }
    const agent = { ...base.agent, ...patch.set } as Record<string, unknown>;
    for (const field of patch.unset ?? []) delete agent[field];
    const project = patch.project !== undefined ? patch.project : base.project;
    const next: Base = { agent: agent as Base["agent"], project, rev: patch.rev };
    this.bases.set(key, next);
    const payload: UpsertPayload = {
      kind: "upsert",
      agent: next.agent,
      ...(project !== undefined ? { project } : {}),
      ...(patch.subscriptionId !== undefined ? { subscriptionId: patch.subscriptionId } : {}),
      ...(patch.generation !== undefined ? { generation: patch.generation } : {}),
      ...(patch.seq !== undefined ? { seq: patch.seq } : {}),
      rev: patch.rev,
    };
    return { kind: "update", message: { type: "agent_update", payload } };
  }

  clear(): void {
    this.bases.clear();
    this.resyncing.clear();
  }
}

function baseKey(subscriptionId: string | undefined, agentId: string): string {
  return `${subscriptionId ?? ""}\u0000${agentId}`;
}
