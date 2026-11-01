import {
  planTimelineCatchUpAfter,
  planTimelineResumeFetch,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";
import type { CachedTimeline, CachedTimelinePage } from "@/runtime/replica-cache";
import {
  selectAgentTimelineState,
  useSessionStore,
  type AgentTimelineCursorState,
  type AgentTimelineState,
} from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { getSendingClientMessageIds } from "@/composer/submission/model";
import {
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
  resolveInitDeferred,
} from "@/utils/agent-initialization";
import {
  createSessionAgentStreamReducerQueue,
  type AgentStreamReducerEvent,
  type ProcessTimelineResponseOutput,
  processTimelineResponse,
} from "./session-stream-reducers";
import { isTimelineResumeSnapshotAuthoritative } from "./timeline-sync-plan";
import { replaceWithCanonicalStream } from "@/types/stream";

export interface TimelineReplicaStorage {
  readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined>;
  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void;
  /** Highest sequence held on disk contiguously from `fromSeq` (sealed pages). */
  archivedThrough?(
    serverId: string,
    agentId: string,
    cursor: { epoch: string; fromSeq: number },
  ): number | undefined;
}

/** In-memory bound for chats nobody is looking at; older items stay on disk and the daemon. */
export const MEMORY_TIMELINE_MAX_ITEMS = 200;
const MEMORY_TIMELINE_MIN_KEEP = 50;

/**
 * Prepends an older page read from disk. Accepted only when it ends right before the loaded
 * range, the same rule as a daemon `before` page. Items already present (by id) are skipped.
 */
export function applyCachedOlderTimelinePage(
  serverId: string,
  agentId: string,
  page: CachedTimelinePage,
): boolean {
  const store = useSessionStore.getState();
  const session = store.sessions[serverId];
  const timeline = selectAgentTimelineState(session, agentId);
  if (timeline.status !== "synced" || !timeline.range || timeline.range.retainedRanges) {
    return false;
  }
  if (
    page.range.epoch !== timeline.range.epoch ||
    page.range.endSeq !== timeline.range.startSeq - 1
  ) {
    return false;
  }
  const existing = new Set(timeline.items.map((item) => item.id));
  const older = page.items.filter((item) => !existing.has(item.id));
  store.applyAgentTimelineResponseState(serverId, agentId, {
    items: [...older, ...timeline.items],
    head: session?.agentStreamHead.get(agentId) ?? [],
    range: { ...timeline.range, startSeq: page.range.startSeq },
    older: page.hasOlder ? "available" : "none",
    newer: timeline.newer === "available",
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
  return true;
}

function splitsAt<Item extends { timelineCursor?: { seq: number } }>(
  items: readonly Item[],
  base: number,
): boolean {
  let seenAbove = false;
  for (const item of items) {
    const seq = item.timelineCursor?.seq;
    if (seq === undefined) return false;
    if (seq > base) seenAbove = true;
    else if (seenAbove) return false;
  }
  return true;
}

async function prepareCachedTimeline(input: {
  serverId: string;
  agentId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
}): Promise<CachedTimeline | undefined> {
  const before = useSessionStore.getState().sessions[input.serverId];
  const beforeTimeline = selectAgentTimelineState(before, input.agentId);
  if (beforeTimeline.status === "synced") return undefined;
  const [stored] = await Promise.all([
    input.storage.readTimeline(input.serverId, input.agentId),
    input.prepareAgent(input.agentId),
  ]);
  if (!stored) return undefined;
  const session = useSessionStore.getState().sessions[input.serverId];
  const currentTimeline = selectAgentTimelineState(session, input.agentId);
  const currentHead = session?.agentStreamHead.get(input.agentId);
  if (currentTimeline.status === "synced") return undefined;
  if (!stored.range) {
    if (beforeTimeline.status === "painted") {
      return currentTimeline.status === "painted" && currentTimeline.items === beforeTimeline.items
        ? stored
        : undefined;
    }
    if (currentTimeline.status !== "cold") return undefined;
  }
  const liveItems =
    currentTimeline.status === "painted"
      ? [...currentTimeline.items, ...(currentHead ?? [])]
      : (currentHead ?? []);
  const replacement = replaceWithCanonicalStream({
    canonical: stored.items,
    previousTail: [],
    previousHead: liveItems,
    sendingClientMessageIds: getSendingClientMessageIds(
      session?.messageSubmissions.get(input.agentId),
    ),
    preserveContinuity: true,
    // Display-only rows claim no coverage over the live head.
    canonicalCoverage: stored.range ?? {
      epoch: liveItems.find((item) => item.timelineCursor)?.timelineCursor?.epoch ?? "",
      endSeq: null,
    },
  });
  useSessionStore.getState().applyAgentTimelineResponseState(input.serverId, input.agentId, {
    items: replacement.tail,
    head: replacement.head,
    range: stored.range,
    older: stored.hasOlder ? "available" : "none",
    newer: false,
    synchronized: false,
    acknowledgedClientMessageIds: replacement.acknowledgedClientMessageIds,
  });
  return stored;
}

export interface TimelineReplica {
  prepare(agentId: string): Promise<void>;
  /** Drops in-memory history that is already sealed on disk, keeping the newest items. */
  trimToArchive(agentId: string): boolean;
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  readRange(agentId: string): AgentTimelineCursorState | undefined;
  timelineUpdated(agentId: string): void;
}

class TimelineReplicaOwner implements TimelineReplica {
  private readonly cachedRanges = new Map<string, AgentTimelineCursorState>();
  private readonly preparations = new Map<string, Promise<void>>();

  constructor(
    private readonly serverId: string,
    private readonly storage: TimelineReplicaStorage,
    private readonly prepareAgent: (agentId: string) => Promise<void>,
  ) {}

  async prepare(agentId: string): Promise<void> {
    const existing = this.preparations.get(agentId);
    if (existing) return existing;
    const preparation = this.load(agentId).finally(() => {
      if (this.preparations.get(agentId) === preparation) {
        this.preparations.delete(agentId);
      }
    });
    this.preparations.set(agentId, preparation);
    return preparation;
  }

  private async load(agentId: string): Promise<void> {
    const stored = await prepareCachedTimeline({
      serverId: this.serverId,
      agentId,
      storage: this.storage,
      prepareAgent: this.prepareAgent,
    });
    if (!stored) return;
    if (stored.range) {
      this.cachedRanges.set(agentId, stored.range);
    }
  }

  trimToArchive(agentId: string): boolean {
    const session = useSessionStore.getState().sessions[this.serverId];
    const timeline = selectAgentTimelineState(session, agentId);
    if (timeline.status !== "synced" || !timeline.range || timeline.range.retainedRanges) {
      return false;
    }
    if (timeline.items.length <= MEMORY_TIMELINE_MAX_ITEMS) return false;
    const archived = this.storage.archivedThrough?.(this.serverId, agentId, {
      epoch: timeline.range.epoch,
      fromSeq: timeline.range.startSeq,
    });
    if (archived === undefined || archived >= timeline.range.endSeq) return false;
    if (!splitsAt(timeline.items, archived)) return false;
    const kept = timeline.items.filter((item) => (item.timelineCursor?.seq ?? 0) > archived);
    if (kept.length < MEMORY_TIMELINE_MIN_KEEP || kept.length === timeline.items.length) {
      return false;
    }
    useSessionStore.getState().applyAgentTimelineResponseState(this.serverId, agentId, {
      items: kept,
      head: session?.agentStreamHead.get(agentId) ?? [],
      range: { ...timeline.range, startSeq: archived + 1 },
      older: "available",
      newer: timeline.newer === "available",
      synchronized: true,
      acknowledgedClientMessageIds: [],
    });
    return true;
  }

  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined {
    const range = this.cachedRanges.get(agentId);
    return range ? { epoch: range.epoch, endSeq: range.endSeq } : undefined;
  }

  readRange(agentId: string): AgentTimelineCursorState | undefined {
    return this.cachedRanges.get(agentId);
  }

  timelineUpdated(agentId: string): void {
    const session = useSessionStore.getState().sessions[this.serverId];
    const timeline = selectAgentTimelineState(session, agentId);
    // Only a synced timeline is saved. A painted one is the cache itself plus rows without a
    // cursor; saving it would replace the cached cursor with none.
    if (timeline.status !== "synced") return;
    this.cachedRanges.delete(agentId);
    this.storage.commitTimeline(this.serverId, agentId, {
      agentId,
      items: [...timeline.items, ...(session?.agentStreamHead.get(agentId) ?? [])],
      range: timeline.range,
      hasOlder: timeline.older === "available",
    });
  }
}

export function createTimelineReplica(input: {
  serverId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
}): TimelineReplica {
  return new TimelineReplicaOwner(input.serverId, input.storage, input.prepareAgent);
}

export interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

export type TimelineResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agent_timeline_response" }
>["payload"];

export function consumeForcedTimelineTailReplacement(
  payload: TimelineResponsePayload,
  replacements: Set<string>,
): TimelineResponsePayload {
  if (payload.direction !== "tail") return payload;
  if (!replacements.delete(payload.agentId)) return payload;
  return { ...payload, reset: true };
}

function clearAgentInitializingFlag(serverId: string, agentId: string): void {
  useSessionStore.getState().setInitializingAgents(serverId, (previous) => {
    if (previous.get(agentId) !== true) return previous;
    const next = new Map(previous);
    next.set(agentId, false);
    return next;
  });
}

function commitProcessedTimeline(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  result: ProcessTimelineResponseOutput;
  timeline: AgentTimelineState;
  currentCursor: AgentTimelineCursorState | undefined;
  synchronized: boolean;
}): void {
  const { serverId, payload, result, timeline, currentCursor, synchronized } = input;
  const agentId = payload.agentId;
  const store = useSessionStore.getState();
  if (result.commit !== "discard") {
    store.applyAgentTimelineResponseState(serverId, agentId, {
      items: result.tail,
      head: result.head,
      range: result.cursorChanged ? (result.cursor ?? null) : (currentCursor ?? null),
      older: result.older,
      newer:
        payload.direction === "before"
          ? timeline.status === "synced" && timeline.newer === "available"
          : payload.hasNewer,
      synchronized,
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
    return;
  }
  if (result.acknowledgedClientMessageIds.length > 0) {
    store.setAgentStreamState(serverId, agentId, {
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
  }
  if (payload.direction !== "before") {
    store.setAgentTimelineHasNewer(serverId, (current) => {
      const next = new Map(current);
      next.set(agentId, payload.hasNewer);
      return next;
    });
  }
  store.markAgentHistorySynchronized(serverId, agentId);
}

function finalizeProcessedTimeline(input: {
  serverId: string;
  agentId: string;
  initKey: string;
  result: ProcessTimelineResponseOutput;
  synchronized: boolean;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): void {
  for (const effect of input.result.sideEffects) {
    if (effect.type === "catch_up") input.recoverGap(input.agentId, effect.cursor);
  }
  if (input.result.clearInitializing) {
    clearAgentInitializingFlag(input.serverId, input.agentId);
  }
  if (input.synchronized) {
    const session = useSessionStore.getState().sessions[input.serverId];
    const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
    if (agent && agent.turn.phase === "idle") input.drainQueuedAgentMessage(input.agentId);
  }
  if (input.result.initResolution === "resolve") resolveInitDeferred(input.initKey);
}

function applyAuthoritativeTimelineResponse(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  cachedCursor?: AgentTimelineCursorState;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): boolean {
  const { serverId, payload } = input;
  const agentId = payload.agentId;
  const initKey = getInitKey(serverId, agentId);
  const session = useSessionStore.getState().sessions[serverId];
  const timeline = selectAgentTimelineState(session, agentId);
  const activeInitDeferred = getInitDeferred(initKey);
  // Not synced yet: the cursor is the cached one, or where an earlier page of this catch-up
  // (applied without completing the sync) left it.
  const currentCursor =
    timeline.status === "synced"
      ? (timeline.range ?? undefined)
      : (session?.agentTimelineCursor.get(agentId) ?? input.cachedCursor);
  const processed = processTimelineResponse({
    payload,
    currentTail: timeline.status === "cold" ? [] : timeline.items,
    currentHead: session?.agentStreamHead.get(agentId) ?? [],
    currentCursor,
    isInitializing: session?.initializingAgents.get(agentId) === true,
    hasActiveInitDeferred: Boolean(activeInitDeferred),
    initRequestDirection: activeInitDeferred?.requestDirection ?? "tail",
    sendingClientMessageIds: getSendingClientMessageIds(session?.messageSubmissions.get(agentId)),
    paintedWithoutCursor: timeline.status === "painted" && !currentCursor,
  });

  const synchronized = isTimelineResumeSnapshotAuthoritative({
    direction: payload.direction,
    hasNewer: payload.hasNewer,
    error: payload.error,
  });
  // A page with nothing new still completes the sync of a painted chat: its rows become the base.
  const result =
    processed.commit === "discard" && timeline.status !== "synced" && synchronized
      ? { ...processed, commit: "apply" as const }
      : processed;

  if (result.error) {
    if (result.clearInitializing) clearAgentInitializingFlag(serverId, agentId);
    if (result.initResolution === "reject") rejectInitDeferred(initKey, new Error(result.error));
    return false;
  }

  commitProcessedTimeline({ serverId, payload, result, timeline, currentCursor, synchronized });
  finalizeProcessedTimeline({
    serverId,
    agentId,
    initKey,
    result,
    synchronized,
    recoverGap: input.recoverGap,
    drainQueuedAgentMessage: input.drainQueuedAgentMessage,
  });
  return true;
}

/**
 * How a catch-up fetch should be sent. Background fetches are for keep-live chats nobody is
 * looking at: they may be compacted (tool output omitted) and must never resume an unloaded agent.
 */
export interface TimelineFetchOptions {
  background: boolean;
  compact: boolean;
}

export interface ViewedTimelineSyncPorts {
  prepare(agentId: string): Promise<void>;
  replaceDemandedAgentIds(agentIds: string[]): void;
  observe(agentIds: string[]): { ready: Promise<unknown>; release(): Promise<void> };
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  fetchPage(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
    options?: TimelineFetchOptions,
  ): Promise<TimelinePageResult>;
  fetchLatestTail(agentId: string, options?: TimelineFetchOptions): Promise<TimelinePageResult>;
  /**
   * The sync no longer owes this chat a catch-up: it reached current, or it left the
   * demanded set. Disconnect and backgrounding keep the obligation and do not report here.
   */
  onCatchUpEnded(agentId: string): void;
  reportError(error: unknown): void;
  schedule(task: () => void, delayMs: number): () => void;
}

export type ViewedTimelineStatus = "ready" | "pending" | "error" | "retrying";

export interface ViewedTimelineUiBridge {
  replaceVisibleAgentIds(sourceId: string, agentIds: string[]): void;
  subscribe(listener: () => void): () => void;
  getAgentTimelineStatus(agentId: string): ViewedTimelineStatus;
  getAgentTimelineError(agentId: string): string | null;
  retryVisibleAgentTimeline(agentId: string): void;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  /**
   * The agent tabs that currently exist in workspace layout. This only ever *releases*
   * subscriptions: closing a tab drops its chat. It never adds one, because layout is
   * restored from disk at launch and those tabs are chats the user opened days ago.
   */
  replaceOpenTabAgentIds(agentIds: string[]): void;
  /**
   * Keep-live chats (bot chats labelled paseo.keep-live), highest priority first. They are
   * subscribed from connect without being opened and caught up one at a time after visible
   * chats, so opening one needs no fetch. Callers pass only agents loaded on the daemon.
   */
  replaceKeepLiveAgentIds(agentIds: string[]): void;
  /**
   * Constrained mode (slow link): keep-live chats nobody is looking at drop out of the live
   * subscription and are pulled once per finished turn instead.
   */
  setConstrained(constrained: boolean): void;
  /** Directory status of a keep-live agent changed (drives constrained-mode pulls). */
  notifyAgentActivity(agentId: string, phase: "running" | "idle"): void;
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  isAgentVisible(agentId: string): boolean;
  visibleAgentIds(): string[];
  recoverGap(agentId: string, cursor: { epoch: string; endSeq: number }): void;
  dispose(): void;
}

export type ViewedTimelineOwnerPorts = Omit<
  ViewedTimelineSyncPorts,
  "prepare" | "replaceDemandedAgentIds" | "onCatchUpEnded"
>;

export interface ViewedTimelineOwner extends ViewedTimelineSync {
  applyTimelineResponse(payload: TimelineResponsePayload): void;
  enqueueStreamEvent(agentId: string, event: AgentStreamReducerEvent): void;
  flushStreamAgent(agentId: string): void;
}

export function createViewedTimelineOwner(input: {
  serverId: string;
  replica: TimelineReplica;
  replaceDemandedAgentIds: (agentIds: string[]) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
  ports: ViewedTimelineOwnerPorts;
}): ViewedTimelineOwner {
  const forcedTailReplacements = new Set<string>();
  const sync = createViewedTimelineSync({
    ...input.ports,
    fetchLatestTail: async (agentId, options) => {
      forcedTailReplacements.add(agentId);
      try {
        return await input.ports.fetchLatestTail(agentId, options);
      } finally {
        forcedTailReplacements.delete(agentId);
      }
    },
    prepare: (agentId) => input.replica.prepare(agentId),
    readCursor: (agentId) => input.replica.readCursor(agentId) ?? input.ports.readCursor(agentId),
    replaceDemandedAgentIds: input.replaceDemandedAgentIds,
    onCatchUpEnded: (agentId) =>
      useCreateFlowStore.getState().clearByAgent({ serverId: input.serverId, agentId }),
  });
  const streamQueue = createSessionAgentStreamReducerQueue({
    serverId: input.serverId,
    setAgentStreamState: (...args) => useSessionStore.getState().setAgentStreamState(...args),
    setAgentTimelineCursor: (...args) => useSessionStore.getState().setAgentTimelineCursor(...args),
    recoverTimelineGap: (agentId, cursor) => sync.recoverGap(agentId, cursor),
    onCommitted: (agentId) => {
      input.replica.timelineUpdated(agentId);
      trimIfHidden(agentId);
    },
  });
  function trimIfHidden(agentId: string): void {
    if (!sync.isAgentVisible(agentId)) input.replica.trimToArchive(agentId);
  }
  return {
    ...sync,
    applyTimelineResponse(receivedPayload) {
      const payload = consumeForcedTimelineTailReplacement(receivedPayload, forcedTailReplacements);
      const accepted = applyAuthoritativeTimelineResponse({
        serverId: input.serverId,
        payload,
        cachedCursor: input.replica.readRange(payload.agentId),
        recoverGap: (agentId, cursor) => sync.recoverGap(agentId, cursor),
        drainQueuedAgentMessage: input.drainQueuedAgentMessage,
      });
      if (accepted) {
        input.replica.timelineUpdated(payload.agentId);
        // Live rows held while the chat had no baseline now go through the sequence gate.
        streamQueue.flushAgent(payload.agentId);
        trimIfHidden(payload.agentId);
      }
    },
    replaceVisibleAgentIds(sourceId, agentIds) {
      const before = sync.visibleAgentIds();
      sync.replaceVisibleAgentIds(sourceId, agentIds);
      for (const agentId of before) trimIfHidden(agentId);
    },
    enqueueStreamEvent(agentId, event) {
      streamQueue.enqueue(agentId, event);
    },
    flushStreamAgent(agentId) {
      streamQueue.flushAgent(agentId);
    },
    dispose() {
      streamQueue.dispose({ flush: true });
      sync.dispose();
    },
  };
}

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

type CatchUpStatus = "running" | "complete" | "error";

interface CatchUpState {
  generation: number;
  status: CatchUpStatus;
  request?: ProjectedTimelineForwardFetchPlan;
  cancelRetry?: () => void;
  retryDelayMs?: number;
}

const getNextRetryDelayMs = (previousDelayMs: number | undefined): number => {
  if (previousDelayMs == null) {
    return RETRY_DELAY_MS;
  }
  return Math.min(previousDelayMs * 2, MAX_RETRY_DELAY_MS);
};

function isSameCatchUpRequest(
  left: ProjectedTimelineForwardFetchPlan | undefined,
  right: ProjectedTimelineForwardFetchPlan | undefined,
): boolean {
  if (!left || !right || left.direction !== right.direction) return false;
  if (left.direction !== "after" || right.direction !== "after") return true;
  return left.cursor.epoch === right.cursor.epoch && left.cursor.seq === right.cursor.seq;
}

type CatchUpDecision = "keep" | "keep-and-park" | "replace";

function decideCatchUp(input: {
  current: CatchUpState | undefined;
  request: ProjectedTimelineForwardFetchPlan;
  supersede: boolean;
}): CatchUpDecision {
  if (!input.current) return "replace";
  if (input.supersede) {
    if (
      input.current.status === "running" &&
      isSameCatchUpRequest(input.current.request, input.request)
    ) {
      return "keep";
    }
    if (input.current.status === "running" && input.current.request?.direction === "tail") {
      return "keep-and-park";
    }
    return "replace";
  }
  return input.current.status === "running" || input.current.status === "complete"
    ? "keep"
    : "replace";
}

function isAgentNotLoadedError(error: unknown): boolean {
  return error instanceof Error && error.name === "AgentNotLoadedError";
}

function normalizeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds)].filter(Boolean).sort();
}

function sameAgentIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((agentId, index) => agentId === right[index]);
}

export function createViewedTimelineSync(ports: ViewedTimelineSyncPorts): ViewedTimelineSync {
  const sources = new Map<string, string[]>();
  const catchUps = new Map<string, CatchUpState>();
  const catchUpGenerations = new Map<string, number>();
  // Authoritative fetch owed but not runnable yet: disconnected, unacknowledged, or parked.
  // Membership acknowledgement and catch-up completion drain parked requests.
  const pendingCatchUps = new Map<string, ProjectedTimelineForwardFetchPlan>();
  const visibilityCatchUpPending = new Set<string>();
  const visibilityCatchUpErrors = new Map<string, string>();
  // User-initiated retries only. Background retries stay silent; a retry the user asked for
  // owes them a pending state until it settles.
  const manualRetries = new Set<string>();
  const loadedCache = new Set<string>();
  const cacheLoads = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let active = true;
  let connected = false;
  let observation: {
    handle: ReturnType<ViewedTimelineSyncPorts["observe"]>;
    agentIds: string[];
  } | null = null;
  let disposed = false;
  let desired: string[] = [];
  let acknowledged: string[] = [];
  let membershipGeneration = 0;
  let membershipNeedsRetry = false;
  let membershipRetryDelayMs: number | undefined;
  let cancelMembershipRetry: (() => void) | null = null;
  // Chats this session has opened. Visibility is the only way in, so an agent is never
  // subscribed — and never resumed on the daemon — until the user actually opens it.
  // Membership then survives hiding, workspace switches, backgrounding and reconnect;
  // only closing the tab or ending the session takes it out.
  let openedAgentIds: string[] = [];
  // Keep-live chats in priority order. They join membership without an open.
  let keepLiveAgentIds: string[] = [];
  // Keep-live agents the daemon reported as not loaded; never fetched again until they run.
  const notLoadedAgentIds = new Set<string>();
  let constrained = false;
  // Constrained mode: pulled at turn end and idle since, so revealing one owes no catch-up UI.
  const freshPulled = new Set<string>();
  const pullQueue: string[] = [];
  let pulling: string | null = null;

  const visibleAgentIds = () => normalizeAgentIds([...sources.values()].flat());
  const activeKeepLiveAgentIds = () =>
    keepLiveAgentIds.filter((agentId) => !notLoadedAgentIds.has(agentId));
  const isBackgroundOnly = (agentId: string) =>
    keepLiveAgentIds.includes(agentId) &&
    !openedAgentIds.includes(agentId) &&
    !visibleAgentIds().includes(agentId);
  const fetchOptions = (agentId: string): TimelineFetchOptions => {
    const background = isBackgroundOnly(agentId);
    return { background, compact: background || constrained };
  };
  const runningBackgroundCatchUps = () =>
    [...catchUps.entries()].filter(
      ([agentId, state]) => state.status === "running" && isBackgroundOnly(agentId),
    ).length;

  const rememberOpenedAgentIds = (agentIds: string[]) => {
    if (agentIds.length === 0) return;
    const next = normalizeAgentIds([...openedAgentIds, ...agentIds]);
    if (sameAgentIds(next, openedAgentIds)) return;
    openedAgentIds = next;
  };

  const isAcknowledged = (agentId: string) => acknowledged.includes(agentId);
  const isDesired = (agentId: string) => desired.includes(agentId);
  const canCatchUp = (agentId: string) =>
    !disposed && connected && isDesired(agentId) && isAcknowledged(agentId);
  const ownsCatchUp = (agentId: string, generation: number) =>
    canCatchUp(agentId) && catchUps.get(agentId)?.generation === generation;

  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };

  const setVisibilityCatchUpReady = (agentId: string) => {
    const wasPending = visibilityCatchUpPending.delete(agentId);
    const hadError = visibilityCatchUpErrors.delete(agentId);
    const wasRetrying = manualRetries.delete(agentId);
    ports.onCatchUpEnded(agentId);
    if (wasPending || hadError || wasRetrying) notifyListeners();
  };

  const setVisibilityCatchUpError = (agentIds: string[], error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let changed = false;
    for (const agentId of agentIds) {
      if (manualRetries.delete(agentId)) changed = true;
      if (visibilityCatchUpPending.delete(agentId)) changed = true;
      if (visibilityCatchUpErrors.get(agentId) !== message) {
        visibilityCatchUpErrors.set(agentId, message);
        changed = true;
      }
    }
    if (changed) notifyListeners();
  };

  const cancelCatchUp = (agentId: string) => {
    catchUpGenerations.set(agentId, (catchUpGenerations.get(agentId) ?? 0) + 1);
    catchUps.get(agentId)?.cancelRetry?.();
    catchUps.delete(agentId);
    pendingCatchUps.delete(agentId);
  };

  const fetchUntilCurrent = async (
    agentId: string,
    generation: number,
    request: ProjectedTimelineForwardFetchPlan,
    fallbackToLatestTailOnOverflow: boolean,
  ): Promise<void> => {
    if (!ownsCatchUp(agentId, generation)) return;

    try {
      const page = await ports.fetchPage(agentId, request, fetchOptions(agentId));
      if (!ownsCatchUp(agentId, generation)) return;
      if (page.hasNewer && page.endCursor) {
        if (fallbackToLatestTailOnOverflow) {
          await ports.fetchLatestTail(agentId, fetchOptions(agentId));
          if (!ownsCatchUp(agentId, generation)) return;
          catchUps.set(agentId, { generation, status: "complete" });
          setVisibilityCatchUpReady(agentId);
          return;
        }
        await fetchUntilCurrent(
          agentId,
          generation,
          planTimelineCatchUpAfter(page.endCursor),
          false,
        );
        return;
      }
      if (page.hasNewer) {
        throw new Error(`Timeline page for ${agentId} hasNewer without an end cursor`);
      }
      catchUps.set(agentId, { generation, status: "complete" });
      const pendingCatchUp = pendingCatchUps.get(agentId);
      if (pendingCatchUp) {
        startCatchUp(agentId, { request: pendingCatchUp, supersede: true });
        return;
      }
      setVisibilityCatchUpReady(agentId);
    } catch (error) {
      if (catchUps.get(agentId)?.generation === generation && isAgentNotLoadedError(error)) {
        // Never retry (or resume) an agent the daemon does not hold in memory.
        catchUps.set(agentId, { generation, status: "complete" });
        if (isBackgroundOnly(agentId)) {
          notLoadedAgentIds.add(agentId);
          publishVisibleMembership();
          return;
        }
      }
      if (catchUps.get(agentId)?.generation === generation) {
        const nextRetryDelayMs = getNextRetryDelayMs(catchUps.get(agentId)?.retryDelayMs);
        const cancelRetry = ports.schedule(() => {
          const current = catchUps.get(agentId);
          if (current?.generation !== generation || current.status !== "error") return;
          startCatchUp(agentId);
        }, nextRetryDelayMs);
        catchUps.set(agentId, {
          generation,
          status: "error",
          request,
          cancelRetry,
          retryDelayMs: nextRetryDelayMs,
        });
        setVisibilityCatchUpError([agentId], error);
        ports.reportError(error);
      }
    } finally {
      startAcknowledgedCatchUps();
    }
  };

  const ensureCacheLoaded = (agentId: string): void => {
    if (loadedCache.has(agentId) || cacheLoads.has(agentId)) return;
    const load = ports
      .prepare(agentId)
      .catch((error) => ports.reportError(error))
      .finally(() => {
        cacheLoads.delete(agentId);
        loadedCache.add(agentId);
        const pending = pendingCatchUps.get(agentId);
        startCatchUp(agentId, { request: pending, supersede: Boolean(pending) });
      });
    cacheLoads.set(agentId, load);
  };

  // Existing streams and retries continue; only initial hidden catch-ups wait.
  const shouldWaitForVisibleCatchUp = (agentId: string) => {
    if (!active || catchUps.has(agentId)) return false;
    const visible = visibleAgentIds();
    return (
      !visible.includes(agentId) &&
      visible.some((id) => {
        const status = catchUps.get(id)?.status;
        return isDesired(id) && (status === undefined || status === "running");
      })
    );
  };

  // Keep-live chats nobody opened catch up one at a time so a chat the user taps
  // competes with at most one background fetch on a slow link.
  const shouldDeferCatchUp = (agentId: string, supersede: boolean) =>
    shouldWaitForVisibleCatchUp(agentId) ||
    (!supersede &&
      !catchUps.has(agentId) &&
      isBackgroundOnly(agentId) &&
      runningBackgroundCatchUps() > 0);

  // A parked or retried `after` request starts from the cursor it was planned at. Rows applied
  // since then are not asked for twice.
  const rebaseOnCurrentCursor = (
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): ProjectedTimelineForwardFetchPlan => {
    if (request.direction !== "after") return request;
    const current = ports.readCursor(agentId);
    if (
      !current ||
      current.epoch !== request.cursor.epoch ||
      current.endSeq <= request.cursor.seq
    ) {
      return request;
    }
    return planTimelineCatchUpAfter({ epoch: current.epoch, seq: current.endSeq });
  };

  const startCatchUp = (
    agentId: string,
    options: {
      request?: ProjectedTimelineForwardFetchPlan;
      supersede?: boolean;
    } = {},
  ) => {
    const { request, supersede = false } = options;
    if (!canCatchUp(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    if (shouldDeferCatchUp(agentId, supersede)) {
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    if (!loadedCache.has(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      ensureCacheLoaded(agentId);
      return;
    }
    const nextRequest = request
      ? rebaseOnCurrentCursor(agentId, request)
      : planTimelineResumeFetch(ports.readCursor(agentId));
    const current = catchUps.get(agentId);
    const decision = decideCatchUp({ current, request: nextRequest, supersede });
    if (decision === "keep-and-park") {
      pendingCatchUps.set(agentId, nextRequest);
      return;
    }
    if (decision === "keep") {
      return;
    }
    current?.cancelRetry?.();
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    const retryDelayMs =
      supersede || current?.status !== "error" ? undefined : current.retryDelayMs;
    catchUps.set(agentId, {
      generation,
      status: "running",
      request: nextRequest,
      retryDelayMs,
    });
    pendingCatchUps.delete(agentId);
    void fetchUntilCurrent(
      agentId,
      generation,
      nextRequest,
      request === undefined && nextRequest.direction === "after",
    );
  };

  const startAcknowledgedCatchUps = () => {
    const visible = visibleAgentIds();
    const keepLiveOrder = activeKeepLiveAgentIds();
    const rank = (id: string) => {
      const index = keepLiveOrder.indexOf(id);
      return openedAgentIds.includes(id) || index < 0 ? -1 : index;
    };
    const ordered = [
      ...visible.filter(isAcknowledged),
      ...acknowledged.filter((id) => !visible.includes(id)).sort((a, b) => rank(a) - rank(b)),
    ];
    for (const agentId of ordered) {
      const pendingCatchUp = pendingCatchUps.get(agentId);
      const current = catchUps.get(agentId);
      // Completion of a different chat must not bypass a failed chat's backoff or
      // supersede an in-flight tail that owns its parked gap recovery.
      if (current && !(current.status === "complete" && pendingCatchUp)) continue;
      startCatchUp(agentId, {
        request: pendingCatchUp,
        supersede: Boolean(pendingCatchUp),
      });
    }
  };

  const reconcileMembership = async (): Promise<void> => {
    if (disposed || !connected) return;
    const generation = membershipGeneration;
    const requested = desired;
    if (!membershipNeedsRetry && sameAgentIds(requested, observation?.agentIds ?? acknowledged))
      return;
    membershipNeedsRetry = false;
    try {
      const previous = observation;
      const handle = ports.observe(requested);
      observation = { handle, agentIds: requested };
      void previous?.handle.release().catch(ports.reportError);
      await handle.ready;
    } catch (error) {
      if (disposed || !connected || generation !== membershipGeneration) return;
      membershipNeedsRetry = true;
      setVisibilityCatchUpError(requested, error);
      cancelMembershipRetry?.();
      const nextRetryDelayMs = getNextRetryDelayMs(membershipRetryDelayMs);
      cancelMembershipRetry = ports.schedule(() => {
        cancelMembershipRetry = null;
        if (disposed || !connected || membershipGeneration !== generation) return;
        void reconcileMembership();
      }, nextRetryDelayMs);
      membershipRetryDelayMs = nextRetryDelayMs;
      ports.reportError(error);
      return;
    }
    if (disposed || !connected || generation !== membershipGeneration) return;
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
    acknowledged = requested;
    startAcknowledgedCatchUps();
  };

  const retryVisibleAgentTimeline = (agentId: string) => {
    if (!isDesired(agentId) || manualRetries.has(agentId)) return;
    const catchUp = catchUps.get(agentId);
    const membershipRetryable = membershipNeedsRetry && connected;
    if (catchUp?.status !== "error" && !membershipRetryable) return;
    manualRetries.add(agentId);
    notifyListeners();
    if (catchUp?.status === "error") {
      catchUp.cancelRetry?.();
      startCatchUp(agentId, { request: catchUp.request, supersede: true });
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
    void reconcileMembership();
  };

  const commitDesiredMembership = (
    nextDesired: string[],
    options: { resetCatchUpStatus?: boolean } = {},
  ) => {
    let statusChanged = false;
    if (options.resetCatchUpStatus) {
      for (const agentId of nextDesired) {
        if (!visibilityCatchUpPending.has(agentId)) {
          visibilityCatchUpPending.add(agentId);
          statusChanged = true;
        }
        if (visibilityCatchUpErrors.delete(agentId)) statusChanged = true;
        if (manualRetries.delete(agentId)) statusChanged = true;
      }
    }
    if (sameAgentIds(nextDesired, desired)) {
      if (statusChanged) notifyListeners();
      return;
    }

    const released: string[] = [];
    for (const agentId of desired) {
      if (!nextDesired.includes(agentId)) {
        cancelCatchUp(agentId);
        visibilityCatchUpPending.delete(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
        released.push(agentId);
      }
    }
    for (const agentId of nextDesired) {
      if (!desired.includes(agentId)) {
        if (!freshPulled.has(agentId)) visibilityCatchUpPending.add(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
        ensureCacheLoaded(agentId);
      }
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    desired = nextDesired;
    ports.replaceDemandedAgentIds(desired);
    membershipGeneration += 1;
    for (const agentId of released) ports.onCatchUpEnded(agentId);
    notifyListeners();
    void reconcileMembership();
  };

  const publishVisibleMembership = () => {
    const keepLive = constrained ? [] : activeKeepLiveAgentIds();
    commitDesiredMembership(
      normalizeAgentIds([...openedAgentIds, ...visibleAgentIds(), ...keepLive]),
    );
  };

  const isPullable = (agentId: string) =>
    constrained &&
    connected &&
    !disposed &&
    activeKeepLiveAgentIds().includes(agentId) &&
    !isDesired(agentId);

  const enqueuePull = (agentId: string) => {
    if (!isPullable(agentId) || pullQueue.includes(agentId) || pulling === agentId) return;
    pullQueue.push(agentId);
    const order = activeKeepLiveAgentIds();
    pullQueue.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    drainPulls();
  };

  const drainPulls = () => {
    if (pulling !== null) return;
    const agentId = pullQueue.shift();
    if (agentId === undefined) return;
    if (!isPullable(agentId)) {
      drainPulls();
      return;
    }
    pulling = agentId;
    void (async () => {
      try {
        await ports.prepare(agentId);
        const options: TimelineFetchOptions = { background: true, compact: true };
        const page = await ports.fetchPage(
          agentId,
          planTimelineResumeFetch(ports.readCursor(agentId)),
          options,
        );
        if (page.hasNewer) await ports.fetchLatestTail(agentId, options);
        freshPulled.add(agentId);
      } catch (error) {
        if (isAgentNotLoadedError(error)) notLoadedAgentIds.add(agentId);
        else ports.reportError(error);
      } finally {
        pulling = null;
        drainPulls();
      }
    })();
  };

  const enqueueAllPulls = () => {
    for (const agentId of activeKeepLiveAgentIds()) enqueuePull(agentId);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAgentTimelineStatus(agentId) {
      if (manualRetries.has(agentId)) return "retrying";
      if (visibilityCatchUpErrors.has(agentId)) return "error";
      if (!isDesired(agentId) || visibilityCatchUpPending.has(agentId)) return "pending";
      return "ready";
    },
    getAgentTimelineError(agentId) {
      return visibilityCatchUpErrors.get(agentId) ?? null;
    },
    replaceOpenTabAgentIds(agentIds) {
      const openTabs = new Set(agentIds);
      const next = openedAgentIds.filter((agentId) => openTabs.has(agentId));
      if (sameAgentIds(next, openedAgentIds)) return;
      openedAgentIds = next;
      publishVisibleMembership();
    },
    replaceKeepLiveAgentIds(agentIds) {
      const next = [...new Set(agentIds)].filter(Boolean);
      if (
        next.length === keepLiveAgentIds.length &&
        next.every((id, i) => id === keepLiveAgentIds[i])
      )
        return;
      const added = next.filter((agentId) => !keepLiveAgentIds.includes(agentId));
      keepLiveAgentIds = next;
      for (const agentId of freshPulled) {
        if (!next.includes(agentId)) freshPulled.delete(agentId);
      }
      publishVisibleMembership();
      if (constrained) for (const agentId of added) enqueuePull(agentId);
      startAcknowledgedCatchUps();
    },
    setConstrained(nextConstrained) {
      if (constrained === nextConstrained) return;
      constrained = nextConstrained;
      if (!constrained) {
        pullQueue.length = 0;
        freshPulled.clear();
      }
      publishVisibleMembership();
      if (constrained) enqueueAllPulls();
      startAcknowledgedCatchUps();
    },
    notifyAgentActivity(agentId, phase) {
      if (phase === "running") {
        freshPulled.delete(agentId);
        if (notLoadedAgentIds.delete(agentId)) publishVisibleMembership();
        return;
      }
      enqueuePull(agentId);
    },
    replaceVisibleAgentIds(sourceId, agentIds) {
      const normalized = normalizeAgentIds(agentIds);
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, normalized);
      rememberOpenedAgentIds(normalized);
      publishVisibleMembership();
      startAcknowledgedCatchUps();
    },
    setActive(nextActive) {
      if (active === nextActive) return;
      active = nextActive;
      publishVisibleMembership();
      if (!active) {
        startAcknowledgedCatchUps();
        return;
      }
      for (const agentId of visibleAgentIds()) {
        visibilityCatchUpPending.add(agentId);
        visibilityCatchUpErrors.delete(agentId);
        startCatchUp(agentId, { supersede: true });
      }
      notifyListeners();
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        freshPulled.clear();
        pullQueue.length = 0;
        commitDesiredMembership(desired, { resetCatchUpStatus: true });
        cancelMembershipRetry?.();
        cancelMembershipRetry = null;
        membershipRetryDelayMs = undefined;
        void observation?.handle.release().catch(ports.reportError);
        observation = null;
        acknowledged = [];
        membershipGeneration += 1;
        for (const agentId of desired) cancelCatchUp(agentId);
        return;
      }
      membershipGeneration += 1;
      void reconcileMembership();
      if (constrained) enqueueAllPulls();
    },
    recoverGap(agentId, cursor) {
      if (!isDesired(agentId)) return;
      if (catchUps.get(agentId)?.status === "running") {
        // The running catch-up's page may have been cut before the live rows that were just
        // dropped as a gap. Ask again once it lands, from wherever the timeline then is.
        pendingCatchUps.set(
          agentId,
          planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq }),
        );
        return;
      }
      startCatchUp(agentId, {
        request: planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq }),
        supersede: true,
      });
    },
    dispose() {
      disposed = true;
      void observation?.handle.release().catch(ports.reportError);
      observation = null;
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipNeedsRetry = false;
      membershipRetryDelayMs = undefined;
      sources.clear();
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = [];
      ports.replaceDemandedAgentIds([]);
      acknowledged = [];
      openedAgentIds = [];
      keepLiveAgentIds = [];
      pullQueue.length = 0;
      freshPulled.clear();
      loadedCache.clear();
      cacheLoads.clear();
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
      notifyListeners();
      listeners.clear();
    },
    retryVisibleAgentTimeline,
    isAgentVisible: (agentId) => visibleAgentIds().includes(agentId),
    visibleAgentIds,
  };
}
