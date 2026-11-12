import type pino from "pino";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import { resolveEffectiveThinkingOptionId, toAgentPayload } from "../../agent/agent-projections.js";

type AgentUpdatePayload = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];
type AgentUpdatesFilter = NonNullable<
  Extract<SessionInboundMessage, { type: "fetch_agents_request" }>["filter"]
>;

interface AgentUpdatesSubscriptionState {
  subscriptionId: string;
  emit: (message: SessionOutboundMessage) => void;
  syncEnabled: boolean;
  filter?: AgentUpdatesFilter;
  isProviderVisible: (provider: string) => boolean;
  isBootstrapping: boolean;
  pendingUpdatesByAgentId: Map<string, AgentUpdatePayload>;
  /** agent_patches: what this subscription last sent per agent, so the next send is a patch. */
  patches: boolean;
  snapshotBases: boolean;
  sent: Map<string, SentAgent>;
}

interface SentAgent {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload | null;
  rev: number;
}

type AgentPatchPayload = Extract<SessionOutboundMessage, { type: "agent_patch" }>["payload"];

/**
 * The top-level agent fields that differ from what this subscription last sent. Field values are
 * compared as JSON: payloads are built by the same code, so key order is stable.
 */
export function diffAgentSnapshot(
  previous: AgentSnapshotPayload,
  next: AgentSnapshotPayload,
): { set: Record<string, unknown>; unset: string[] } {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue;
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) set[key] = after[key];
  }
  for (const key of Object.keys(before)) {
    if (before[key] !== undefined && after[key] === undefined) unset.push(key);
  }
  return { set, unset };
}

/** Owns filtered agent snapshots and live updates for independent observers. */
export interface AgentUpdatesService {
  beginSubscription(input: {
    subscriptionId: string;
    isProviderVisible?: (provider: string) => boolean;
    emit?: (message: SessionOutboundMessage) => void;
    filter?: AgentUpdatesFilter;
    syncEnabled?: boolean;
    /** Client capability agent_patches on this subscription's socket. */
    patches?: boolean;
    /** A6: the client also seeds patch bases from the snapshot (agent_patches + compact_v2). */
    snapshotBases?: boolean;
  }): void;
  /** The client lost an agent_patch base: the next update of this agent goes out in full. */
  forgetSent(agentId: string): void;
  /**
   * A6: the bootstrap snapshot rows become rev 1 of each agent on a patching subscription, so
   * the first live change is a patch. Returns true when it seeded (the response says patchBase).
   */
  seedSnapshot(
    subscriptionId: string,
    entries: ReadonlyArray<{
      agent: AgentSnapshotPayload;
      project?: ProjectPlacementPayload | null;
    }>,
  ): boolean;
  flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): void;
  clearSubscription(subscriptionId: string): void;
  hasSubscription(): boolean;
  includesLiveAgent(agent: ManagedAgent, subscriptionIds?: ReadonlySet<string>): Promise<boolean>;
  forwardLiveAgent(agent: ManagedAgent): Promise<void>;
  emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload>;
  removeAgent(agentId: string): Promise<void>;
  dispose(): void;
}

export interface AgentUpdatesServiceDeps {
  includesWorkspace?(agent: AgentSnapshotPayload, includeBackground?: boolean): Promise<boolean>;
  emit(message: SessionOutboundMessage): void;
  enrichAgentPayload(payload: AgentSnapshotPayload): Promise<AgentSnapshotPayload>;
  /**
   * D0: the wire shape of a live agent for this client (toClientAgentPayload for priority_sync
   * clients, unchanged for the rest). Defaults to unchanged.
   */
  clientAgentPayload?(payload: AgentSnapshotPayload): AgentSnapshotPayload;
  buildStoredAgentPayload(record: StoredAgentRecord): AgentSnapshotPayload;
  isProviderVisibleToClient(provider: string): boolean;
  buildProjectPlacementForWorkspaceId(workspaceId: string): Promise<ProjectPlacementPayload | null>;
  emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void>;
  sequenceAgentUpdate<T extends AgentUpdatePayload>(
    payload: T,
    agent: AgentSnapshotPayload | null,
    project: ProjectPlacementPayload | null,
    agentId: string,
    includeSequence: boolean,
    includeBackground?: boolean,
  ): T;
  logger: pino.Logger;
}

function agentThinkingOptionMatchesFilter(
  agent: AgentSnapshotPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.thinkingOptionId === undefined) {
    return true;
  }
  const expectedThinkingOptionId = resolveEffectiveThinkingOptionId({
    configuredThinkingOptionId: filter.thinkingOptionId ?? null,
  });
  const resolvedThinkingOptionId =
    agent.effectiveThinkingOptionId ??
    resolveEffectiveThinkingOptionId({
      runtimeInfo: agent.runtimeInfo,
      configuredThinkingOptionId: agent.thinkingOptionId ?? null,
    });
  return resolvedThinkingOptionId === expectedThinkingOptionId;
}

function matchesAgentStructuralFilter(
  agent: AgentSnapshotPayload,
  project: ProjectPlacementPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.statuses && filter.statuses.length > 0) {
    const statuses = new Set(filter.statuses);
    if (!statuses.has(agent.status)) {
      return false;
    }
  }

  if (typeof filter.requiresAttention === "boolean") {
    const requiresAttention = agent.requiresAttention ?? false;
    if (requiresAttention !== filter.requiresAttention) {
      return false;
    }
  }

  if (filter.projectKeys && filter.projectKeys.length > 0) {
    const projectKeys = new Set(filter.projectKeys.filter((item) => item.trim().length > 0));
    if (projectKeys.size > 0 && !projectKeys.has(project.projectKey)) {
      return false;
    }
  }
  return true;
}

/**
 * Pure predicate shared by the live subscription stream and the snapshot listing
 * pager: does an agent (with its resolved project placement) satisfy a
 * `fetch_agents` filter?
 */
export function matchesAgentUpdatesFilter(input: {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
  filter?: AgentUpdatesFilter;
}): boolean {
  const { agent, project, filter } = input;

  if (filter?.labels) {
    const matchesLabels = Object.entries(filter.labels).every(
      ([key, value]) => agent.labels[key] === value,
    );
    if (!matchesLabels) {
      return false;
    }
  }

  const includeArchived = filter?.includeArchived ?? false;
  if (!includeArchived && agent.archivedAt) {
    return false;
  }

  if (agent.internal && filter?.includeInternal !== true) {
    return false;
  }

  if (filter && !agentThinkingOptionMatchesFilter(agent, filter)) {
    return false;
  }

  if (filter && !matchesAgentStructuralFilter(agent, project, filter)) {
    return false;
  }

  return true;
}

function agentUpdateTargetId(update: AgentUpdatePayload): string {
  return update.kind === "remove" ? update.agentId : update.agent.id;
}

export function createAgentUpdatesService(deps: AgentUpdatesServiceDeps): AgentUpdatesService {
  const clientAgentPayload = (payload: AgentSnapshotPayload): AgentSnapshotPayload =>
    deps.clientAgentPayload ? deps.clientAgentPayload(payload) : payload;
  const subscriptions = new Map<string, AgentUpdatesSubscriptionState>();
  const liveAgentUpdateTails = new Map<string, Promise<void>>();
  const sequence = <T extends AgentUpdatePayload>(
    sub: AgentUpdatesSubscriptionState,
    payload: T,
    agent: AgentSnapshotPayload | null,
    project: ProjectPlacementPayload | null,
    agentId: string,
  ) =>
    deps.sequenceAgentUpdate(
      payload,
      agent,
      project,
      agentId,
      sub.syncEnabled === true,
      sub.filter?.includeBackground,
    );

  function bufferOrEmit(sub: AgentUpdatesSubscriptionState, payload: AgentUpdatePayload): void {
    if (subscriptions.get(sub.subscriptionId) !== sub) return;
    if (payload.kind === "upsert" && !sub.isProviderVisible(payload.agent.provider)) {
      return;
    }
    if (sub.isBootstrapping) {
      sub.pendingUpdatesByAgentId.set(agentUpdateTargetId(payload), payload);
      return;
    }
    if (sub.patches) {
      const message = toPatchMessage(sub, payload);
      if (message) sub.emit(message);
      return;
    }

    sub.emit({ type: "agent_update", payload });
  }

  /**
   * agent_patches: the first update of an agent goes out in full with rev 1, later ones as the
   * changed fields on top of the previous rev, and one that changes nothing is not sent at all.
   */
  function toPatchMessage(
    sub: AgentUpdatesSubscriptionState,
    payload: AgentUpdatePayload,
  ): SessionOutboundMessage | null {
    if (payload.kind === "remove") {
      sub.sent.delete(payload.agentId);
      return { type: "agent_update", payload };
    }
    const agentId = payload.agent.id;
    const project = payload.project ?? null;
    const previous = sub.sent.get(agentId);
    if (!previous) {
      sub.sent.set(agentId, { agent: payload.agent, project, rev: 1 });
      return { type: "agent_update", payload: { ...payload, rev: 1 } };
    }
    const { set, unset } = diffAgentSnapshot(previous.agent, payload.agent);
    const projectChanged = JSON.stringify(previous.project) !== JSON.stringify(project);
    if (Object.keys(set).length === 0 && unset.length === 0 && !projectChanged) return null;
    const rev = previous.rev + 1;
    sub.sent.set(agentId, { agent: payload.agent, project, rev });
    const patch: AgentPatchPayload = {
      agentId,
      rev,
      baseRev: previous.rev,
      set,
      ...(unset.length > 0 ? { unset } : {}),
      ...(projectChanged ? { project } : {}),
      ...(payload.generation !== undefined ? { generation: payload.generation } : {}),
      ...(payload.seq !== undefined ? { seq: payload.seq } : {}),
    };
    return { type: "agent_patch", payload: patch };
  }

  function forgetSent(agentId: string): void {
    for (const sub of subscriptions.values()) sub.sent.delete(agentId);
  }

  function seedSnapshot(
    subscriptionId: string,
    entries: ReadonlyArray<{
      agent: AgentSnapshotPayload;
      project?: ProjectPlacementPayload | null;
    }>,
  ): boolean {
    const sub = subscriptions.get(subscriptionId);
    if (!sub?.patches || !sub.snapshotBases || !sub.isBootstrapping) return false;
    for (const entry of entries) {
      sub.sent.set(entry.agent.id, { agent: entry.agent, project: entry.project ?? null, rev: 1 });
    }
    return true;
  }

  function beginSubscription(input: {
    subscriptionId: string;
    isProviderVisible?: (provider: string) => boolean;
    emit?: (message: SessionOutboundMessage) => void;
    filter?: AgentUpdatesFilter;
    syncEnabled?: boolean;
    patches?: boolean;
    snapshotBases?: boolean;
  }): void {
    subscriptions.set(input.subscriptionId, {
      ...input,
      emit: input.emit ?? deps.emit,
      syncEnabled: input.syncEnabled ?? false,
      patches: input.patches ?? false,
      snapshotBases: input.snapshotBases ?? false,
      sent: new Map(),
      isProviderVisible: input.isProviderVisible ?? deps.isProviderVisibleToClient,
      isBootstrapping: true,
      pendingUpdatesByAgentId: new Map(),
    });
  }

  function flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): void {
    const sub = subscriptions.get(subscriptionId);
    if (!sub?.isBootstrapping) return;
    sub.isBootstrapping = false;
    const pending = Array.from(sub.pendingUpdatesByAgentId.values());
    sub.pendingUpdatesByAgentId.clear();
    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshotUpdatedAt = options?.snapshotUpdatedAtByAgentId?.get(payload.agent.id);
        if (
          snapshotUpdatedAt !== undefined &&
          Date.parse(payload.agent.updatedAt) < snapshotUpdatedAt
        )
          continue;
      }
      bufferOrEmit(sub, payload);
    }
  }

  function clearSubscription(subscriptionId: string): void {
    subscriptions.delete(subscriptionId);
  }

  function hasSubscription(): boolean {
    return subscriptions.size > 0;
  }

  async function includesLiveAgent(
    agent: ManagedAgent,
    subscriptionIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    const observers = [...subscriptions.values()].filter(
      (sub) => !subscriptionIds || subscriptionIds.has(sub.subscriptionId),
    );
    if (observers.length === 0) return false;
    const payload = await deps.enrichAgentPayload(clientAgentPayload(toAgentPayload(agent)));
    const project = payload.workspaceId
      ? await deps.buildProjectPlacementForWorkspaceId(payload.workspaceId)
      : null;
    const backgroundVisible = await Promise.all(
      observers.map(
        (sub) => deps.includesWorkspace?.(payload, sub.filter?.includeBackground) ?? true,
      ),
    );
    return (
      project !== null &&
      observers.some(
        (sub, index) =>
          backgroundVisible[index] &&
          sub.isProviderVisible(payload.provider) &&
          matchesAgentUpdatesFilter({ agent: payload, project, filter: sub.filter }),
      )
    );
  }

  async function publishPayload(payload: AgentSnapshotPayload): Promise<void> {
    const observers = [...subscriptions.values()];
    if (observers.length === 0) return;
    const project = payload.workspaceId
      ? await deps.buildProjectPlacementForWorkspaceId(payload.workspaceId)
      : null;
    for (const sub of observers) {
      const matches =
        project &&
        ((await deps.includesWorkspace?.(payload, sub.filter?.includeBackground)) ?? true) &&
        matchesAgentUpdatesFilter({ agent: payload, project, filter: sub.filter });
      bufferOrEmit(
        sub,
        sequence(
          sub,
          matches
            ? { kind: "upsert", agent: payload, project }
            : { kind: "remove", agentId: payload.id },
          payload,
          project,
          payload.id,
        ),
      );
    }
  }

  async function emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload> {
    const payload = deps.buildStoredAgentPayload(record);
    await publishPayload(payload);
    return payload;
  }

  async function emitLiveAgentUpdate(payload: AgentSnapshotPayload): Promise<void> {
    try {
      if (hasSubscription()) await publishPayload(await deps.enrichAgentPayload(payload));
      if (payload.workspaceId) await deps.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
    } catch (error) {
      deps.logger.error({ err: error }, "Failed to emit agent update");
    }
  }

  function enqueueAgentUpdate(
    agentId: string,
    emitUpdate: () => void | Promise<void>,
  ): Promise<void> {
    const previous = liveAgentUpdateTails.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(emitUpdate);
    liveAgentUpdateTails.set(agentId, next);
    void next.finally(() => {
      if (liveAgentUpdateTails.get(agentId) === next) {
        liveAgentUpdateTails.delete(agentId);
      }
    });
    return next;
  }

  function forwardLiveAgent(agent: ManagedAgent): Promise<void> {
    if (!hasSubscription()) {
      const workspaceId = agent.workspaceId;
      return workspaceId
        ? enqueueAgentUpdate(agent.id, async () => {
            try {
              await deps.emitWorkspaceUpdateForWorkspaceId(workspaceId);
            } catch (error) {
              deps.logger.error({ err: error }, "Failed to emit workspace update");
            }
          })
        : Promise.resolve();
    }
    const payload = clientAgentPayload(toAgentPayload(agent));
    return enqueueAgentUpdate(payload.id, () => emitLiveAgentUpdate(payload));
  }

  function removeAgent(agentId: string): Promise<void> {
    return enqueueAgentUpdate(agentId, () => {
      for (const sub of subscriptions.values()) {
        bufferOrEmit(sub, sequence(sub, { kind: "remove", agentId }, null, null, agentId));
      }
    });
  }

  function dispose(): void {
    subscriptions.clear();
  }

  return {
    beginSubscription,
    forgetSent,
    seedSnapshot,
    flushBootstrapped,
    clearSubscription,
    hasSubscription,
    includesLiveAgent,
    forwardLiveAgent,
    emitStoredRecord,
    removeAgent,
    dispose,
  };
}
