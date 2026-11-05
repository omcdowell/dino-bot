// Chat desync (Sam, 2026-10-11, iPhone on LTE). The daemon's timeline was right; the phone showed
// a reply twice, a lone "You", and the next reply above the question it answers. Each test below is
// one way the app's copy drifted from the daemon's after a dropped link or a queued send.
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { appendSubmittedUserMessage, createUserMessage, type StreamItem } from "@/types/stream";
import {
  processAgentStreamEvents,
  processTimelineResponse,
  type ProcessTimelineResponseInput,
  type TimelineCursor,
} from "./session-stream-reducers";
import {
  createTimelineReplica,
  createViewedTimelineOwner,
  type TimelineResponsePayload,
  type ViewedTimelineOwner,
} from "./viewed-timeline-sync";
import type { CachedTimeline } from "@/runtime/replica-cache";
import type { ProjectedTimelineForwardFetchPlan } from "./timeline-sync-plan";

const EPOCH = "epoch-1";
const REPLY_1 = "You're right that the 1 was missing.";
const QUESTION = "how do we decide a mid job update vs truly finished?";
const REPLY_2_FIRST = "You";
const REPLY_2_REST = "'ve identified the real issue.";

type Entry = ProcessTimelineResponseInput["payload"]["entries"][number];

function timeline(turnId: string, item: Record<string, unknown>): AgentStreamEventPayload {
  return { type: "timeline", provider: "optchat", turnId, item } as AgentStreamEventPayload;
}

function entry(
  seqStart: number,
  seqEnd: number,
  turnId: string,
  item: Record<string, unknown>,
): Entry {
  return {
    seqStart,
    seqEnd,
    sourceSeqRanges: [{ startSeq: seqStart, endSeq: seqEnd }],
    provider: "optchat",
    turnId,
    item: item as Entry["item"],
    timestamp: new Date(Date.UTC(2026, 9, 11, 16, 20, 0, seqEnd)).toISOString(),
  };
}

function afterPage(input: {
  cursorSeq: number;
  endSeq: number;
  entries: Entry[];
}): ProcessTimelineResponseInput["payload"] {
  return {
    agentId: "agent",
    direction: "after",
    projection: "projected",
    reset: false,
    epoch: EPOCH,
    window: { minSeq: 1, maxSeq: input.endSeq, nextSeq: input.endSeq + 1 },
    startCursor: { seq: input.cursorSeq + 1 },
    endCursor: { seq: input.endSeq },
    entries: input.entries,
    error: null,
    hasNewer: false,
    hasOlder: true,
  };
}

function rows(items: StreamItem[]): string[] {
  return items.flatMap((item) => {
    if (item.kind === "user_message") return [`user: ${item.text}`];
    if (item.kind === "assistant_message") return [`assistant: ${item.text}`];
    return [];
  });
}

interface StreamState {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | undefined;
}

function live(state: StreamState, seq: number, event: AgentStreamEventPayload): StreamState {
  const result = processAgentStreamEvents({
    events: [
      { event, seq, epoch: EPOCH, timestamp: new Date(Date.UTC(2026, 9, 11, 16, 20, 0, seq)) },
    ],
    currentTail: state.tail,
    currentHead: state.head,
    currentCursor: state.cursor,
    hasAuthoritativeBaseline: true,
  });
  return {
    tail: result.tail,
    head: result.head,
    cursor: result.cursorChanged && result.cursor ? result.cursor : state.cursor,
  };
}

function submit(state: StreamState, text: string, clientMessageId: string): StreamState {
  const message = createUserMessage({
    id: clientMessageId,
    clientMessageId,
    text,
    timestamp: new Date(Date.UTC(2026, 9, 11, 16, 26, 55)),
  });
  return {
    ...state,
    ...appendSubmittedUserMessage({ tail: state.tail, head: state.head, message }),
  };
}

describe("chat desync: the app's order equals the daemon's", () => {
  it("does not re-apply rows it already holds when a catch-up page starts before its cursor", () => {
    // The phone holds reply 1, the question, the tool turn and the first chunk of reply 2.
    let state: StreamState = {
      tail: [],
      head: [],
      cursor: { epoch: EPOCH, startSeq: 1, endSeq: 1 },
    };
    state = live(
      state,
      2,
      timeline("T1", { type: "assistant_message", text: "You", messageId: "m1" }),
    );
    state = live(
      state,
      3,
      timeline("T1", { type: "assistant_message", text: REPLY_1.slice(3), messageId: "m1" }),
    );
    state = live(
      state,
      4,
      timeline("T2", {
        type: "user_message",
        text: QUESTION,
        messageId: "c2",
        clientMessageId: "c2",
      }),
    );
    state = live(state, 5, timeline("T2", { type: "reasoning", text: "thinking" }));
    state = live(
      state,
      6,
      timeline("T2", { type: "assistant_message", text: REPLY_2_FIRST, messageId: "m2" }),
    );

    // A catch-up page asked for with an older cursor (seq 1) arrives after those rows.
    const result = processTimelineResponse({
      payload: afterPage({
        cursorSeq: 1,
        endSeq: 7,
        entries: [
          entry(2, 3, "T1", { type: "assistant_message", text: REPLY_1, messageId: "m1" }),
          entry(4, 4, "T2", {
            type: "user_message",
            text: QUESTION,
            messageId: "c2",
            clientMessageId: "c2",
          }),
          entry(5, 5, "T2", { type: "reasoning", text: "thinking" }),
          entry(6, 7, "T2", {
            type: "assistant_message",
            text: REPLY_2_FIRST + REPLY_2_REST,
            messageId: "m2",
          }),
        ],
      }),
      currentTail: state.tail,
      currentHead: state.head,
      currentCursor: state.cursor,
      isInitializing: false,
      hasActiveInitDeferred: false,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
    });

    expect(rows([...result.tail, ...result.head])).toEqual([
      `assistant: ${REPLY_1}`,
      `user: ${QUESTION}`,
      `assistant: ${REPLY_2_FIRST}${REPLY_2_REST}`,
    ]);
    expect(result.cursor).toMatchObject({ endSeq: 7 });
  });

  it("keeps a reply in one piece when the next question is sent before its last chunk", () => {
    // A catch-up left the start of the reply in the committed tail (nothing streaming in the head).
    const replyStart = processTimelineResponse({
      payload: afterPage({
        cursorSeq: 1,
        endSeq: 2,
        entries: [
          entry(2, 2, "T1", { type: "assistant_message", text: REPLY_2_FIRST, messageId: "m1" }),
        ],
      }),
      currentTail: [],
      currentHead: [],
      currentCursor: { epoch: EPOCH, startSeq: 1, endSeq: 1 },
      isInitializing: false,
      hasActiveInitDeferred: false,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
    });
    let state: StreamState = {
      tail: replyStart.tail,
      head: replyStart.head,
      cursor: replyStart.cursor ?? undefined,
    };
    // Sam sends his next question (the outbox shows it at once) while the last chunk is in flight.
    state = submit(state, QUESTION, "c2");
    state = live(
      state,
      3,
      timeline("T1", { type: "assistant_message", text: REPLY_2_REST, messageId: "m1" }),
    );
    state = live(
      state,
      4,
      timeline("T2", {
        type: "user_message",
        text: QUESTION,
        messageId: "c2",
        clientMessageId: "c2",
      }),
    );

    expect(rows([...state.tail, ...state.head])).toEqual([
      `assistant: ${REPLY_2_FIRST}${REPLY_2_REST}`,
      `user: ${QUESTION}`,
    ]);
  });
});

const SERVER_ID = "chat-desync-host";
const AGENT_ID = "agent";

function payload(input: {
  direction: "tail" | "after";
  cursorSeq: number | null;
  endSeq: number;
  entries: Entry[];
}): TimelineResponsePayload {
  return {
    requestId: `page-${input.direction}-${input.cursorSeq ?? "tail"}-${input.endSeq}`,
    agentId: AGENT_ID,
    agent: null,
    direction: input.direction,
    projection: "projected",
    reset: false,
    staleCursor: false,
    gap: false,
    epoch: EPOCH,
    window: { minSeq: 1, maxSeq: input.endSeq, nextSeq: input.endSeq + 1 },
    startCursor: { epoch: EPOCH, seq: input.cursorSeq === null ? 1 : input.cursorSeq + 1 },
    endCursor: { epoch: EPOCH, seq: input.endSeq },
    entries: input.entries,
    error: null,
    hasNewer: false,
    hasOlder: false,
  } as TimelineResponsePayload;
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

describe("chat desync: live chunks dropped while a catch-up is in flight", () => {
  it("fetches again when chunks newer than the catch-up page were dropped as a gap", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    // Daemon rows: 1 question, 2 reasoning, 3 "You", 4 the rest of the reply.
    const daemon: Entry[] = [
      entry(1, 1, "T1", { type: "user_message", text: QUESTION, messageId: "u1" }),
      entry(2, 2, "T1", { type: "reasoning", text: "thinking" }),
      entry(3, 3, "T1", { type: "assistant_message", text: REPLY_2_FIRST, messageId: "m1" }),
      entry(4, 4, "T1", { type: "assistant_message", text: REPLY_2_REST, messageId: "m1" }),
    ];
    const requests: ProjectedTimelineForwardFetchPlan[] = [];
    const held: Array<() => void> = [];
    let daemonEndSeq = 1;
    const rowsUpTo = (endSeq: number) => daemon.filter((row) => row.seqEnd <= endSeq);
    const owner = createViewedTimelineOwner({
      serverId: SERVER_ID,
      replica: createTimelineReplica({
        serverId: SERVER_ID,
        storage: { readTimeline: async () => undefined, commitTimeline: () => undefined },
        prepareAgent: async () => undefined,
      }),
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
      ports: {
        observe: () => ({ ready: Promise.resolve(), release: async () => undefined }),
        readCursor: () => {
          const state = selectAgentTimelineState(
            useSessionStore.getState().sessions[SERVER_ID],
            AGENT_ID,
          );
          return state.status === "synced" && state.range
            ? { epoch: state.range.epoch, endSeq: state.range.endSeq }
            : undefined;
        },
        fetchPage: (_agentId, request) => {
          requests.push(request);
          // The daemon answers from what it holds now; the answer reaches the app later.
          const cursorSeq = request.direction === "after" ? request.cursor.seq : null;
          const endSeq = daemonEndSeq;
          const page = payload({
            direction: request.direction,
            cursorSeq,
            endSeq,
            entries: rowsUpTo(endSeq).filter((row) => cursorSeq === null || row.seqEnd > cursorSeq),
          });
          return new Promise((resolve) => {
            held.push(() => {
              owner.flushStreamAgent(AGENT_ID);
              owner.applyTimelineResponse(page);
              resolve({ hasNewer: false, endCursor: page.endCursor });
            });
          });
        },
        fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
        reportError: () => undefined,
        schedule: () => () => undefined,
      },
    });
    const release = async () => {
      await expect.poll(() => held.length).toBeGreaterThan(0);
      held.shift()?.();
      await Promise.resolve();
    };
    const send = (seq: number) => {
      const row = daemon[seq - 1]!;
      owner.enqueueStreamEvent(AGENT_ID, {
        event: timeline(row.turnId ?? "T1", row.item as Record<string, unknown>),
        seq,
        epoch: EPOCH,
        timestamp: new Date(row.timestamp),
      });
    };

    owner.setConnected(true);
    owner.replaceVisibleAgentIds("screen", [AGENT_ID]);
    await release(); // first tail fetch: up to seq 1

    // Seq 2 is lost on the link; seq 3 shows the gap and starts a catch-up after seq 1.
    daemonEndSeq = 3;
    send(3);
    owner.flushStreamAgent(AGENT_ID);
    await expect.poll(() => held.length).toBe(1);
    // Seq 4 arrives before that catch-up's answer and is dropped as a gap too.
    daemonEndSeq = 4;
    send(4);
    await release(); // the catch-up page ends at seq 3

    // Seq 4 is newer than the page: the app must ask again rather than stop at "You".
    await expect.poll(() => held.length).toBe(1);
    await release();
    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(
      rows([
        ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
        ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
      ]),
    ).toEqual([`user: ${QUESTION}`, `assistant: ${REPLY_2_FIRST}${REPLY_2_REST}`]);
    expect(requests.at(-1)).toMatchObject({ direction: "after", cursor: { seq: 3 } });
    owner.dispose();
  });
});

// Cold start (app relaunch or web reload) while a reply streams. The chat is first painted from the
// device cache, which is not synced with the daemon. Rule: painted rows are a picture, not a base.
// The first page from the daemon replaces them, and live rows that reached the painted chat are
// applied after that page with the usual sequence checks.
describe("chat desync: cold start while a reply streams", () => {
  // Daemon rows: 1 hello, 2 reply, 3 question, 4 reasoning, 5 "You", 6 the rest of the reply.
  const coldDaemon: Entry[] = [
    entry(1, 1, "T0", { type: "user_message", text: "hello", messageId: "u0" }),
    entry(2, 2, "T0", { type: "assistant_message", text: REPLY_1, messageId: "m0" }),
    entry(3, 3, "T1", {
      type: "user_message",
      text: QUESTION,
      messageId: "c1",
      clientMessageId: "c1",
    }),
    entry(4, 4, "T1", { type: "reasoning", text: "thinking" }),
    entry(5, 5, "T1", { type: "assistant_message", text: REPLY_2_FIRST, messageId: "m1" }),
    entry(6, 6, "T1", { type: "assistant_message", text: REPLY_2_REST, messageId: "m1" }),
  ];
  const daemonRows = [
    "user: hello",
    `assistant: ${REPLY_1}`,
    `user: ${QUESTION}`,
    `assistant: ${REPLY_2_FIRST}${REPLY_2_REST}`,
  ];

  // What the app had on screen (and saved) when it was synced up to `endSeq`.
  function syncedItems(endSeq: number): StreamItem[] {
    const result = processTimelineResponse({
      payload: afterPage({
        cursorSeq: 0,
        endSeq,
        entries: coldDaemon.filter((row) => row.seqEnd <= endSeq),
      }),
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      isInitializing: false,
      hasActiveInitDeferred: false,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
    });
    return [...result.tail, ...result.head];
  }

  function coldOwner(input: {
    disk: CachedTimeline;
    daemonEndSeq: () => number;
    held: Array<() => void>;
  }) {
    const saved: { value: CachedTimeline } = { value: input.disk };
    const owner: ViewedTimelineOwner = createViewedTimelineOwner({
      serverId: SERVER_ID,
      replica: createTimelineReplica({
        serverId: SERVER_ID,
        storage: {
          readTimeline: async () => structuredClone(saved.value),
          commitTimeline: (_serverId, _agentId, committed) => {
            saved.value = structuredClone(committed);
          },
        },
        prepareAgent: async () => undefined,
      }),
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
      ports: {
        observe: () => ({ ready: Promise.resolve(), release: async () => undefined }),
        readCursor: () => {
          const state = selectAgentTimelineState(
            useSessionStore.getState().sessions[SERVER_ID],
            AGENT_ID,
          );
          return state.status === "synced" && state.range
            ? { epoch: state.range.epoch, endSeq: state.range.endSeq }
            : undefined;
        },
        fetchPage: (_agentId, request) => {
          const cursorSeq = request.direction === "after" ? request.cursor.seq : null;
          const endSeq = input.daemonEndSeq();
          const page = payload({
            direction: request.direction,
            cursorSeq,
            endSeq,
            entries: coldDaemon.filter(
              (row) => row.seqEnd <= endSeq && (cursorSeq === null || row.seqEnd > cursorSeq),
            ),
          });
          return new Promise((resolve) => {
            input.held.push(() => {
              owner.flushStreamAgent(AGENT_ID);
              owner.applyTimelineResponse(page);
              resolve({ hasNewer: false, endCursor: page.endCursor });
            });
          });
        },
        fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
        reportError: () => undefined,
        schedule: () => () => undefined,
      },
    });
    return { owner, saved };
  }

  function shownRows(): string[] {
    const session = useSessionStore.getState().sessions[SERVER_ID];
    return rows([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]);
  }

  it("replaces rows saved without a cursor instead of stacking the first page under them", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    // A painted chat that drew live rows saved them without a cursor: reply 1, the question
    // sent from this device, and the first chunk of reply 2.
    const disk: CachedTimeline = {
      agentId: AGENT_ID,
      items: [
        ...syncedItems(2),
        createUserMessage({
          id: "c1",
          clientMessageId: "c1",
          text: QUESTION,
          timestamp: new Date(Date.UTC(2026, 9, 11, 16, 26, 55)),
        }),
        ...syncedItems(5).slice(-1),
      ],
      range: null,
      hasOlder: false,
    };
    const held: Array<() => void> = [];
    const { owner } = coldOwner({ disk, daemonEndSeq: () => 6, held });

    owner.setConnected(true);
    owner.replaceVisibleAgentIds("screen", [AGENT_ID]);
    await expect.poll(() => held.length).toBe(1);
    held.shift()?.();

    expect(shownRows()).toEqual(daemonRows);
    owner.dispose();
  });

  it("holds live chunks that reach a painted chat and applies them after its first page", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const disk: CachedTimeline = {
      agentId: AGENT_ID,
      items: syncedItems(2),
      range: { epoch: EPOCH, startSeq: 1, endSeq: 2 },
      hasOlder: false,
    };
    const held: Array<() => void> = [];
    const { owner, saved } = coldOwner({ disk, daemonEndSeq: () => 5, held });

    owner.setConnected(true);
    owner.replaceVisibleAgentIds("screen", [AGENT_ID]);
    await expect.poll(() => held.length).toBe(1);
    // The catch-up after seq 2 is on the wire (the daemon answered up to seq 5). The reply's two
    // chunks arrive live before that answer.
    for (const seq of [5, 6]) {
      const row = coldDaemon[seq - 1]!;
      owner.enqueueStreamEvent(AGENT_ID, {
        event: timeline(row.turnId ?? "T1", row.item as Record<string, unknown>),
        seq,
        epoch: EPOCH,
        timestamp: new Date(row.timestamp),
      });
    }
    owner.flushStreamAgent(AGENT_ID);

    // Nothing unsequenced is drawn over the cached rows, and the cache keeps its cursor.
    expect.soft(shownRows()).toEqual(daemonRows.slice(0, 2));
    expect.soft(saved.value.range).toEqual({ epoch: EPOCH, startSeq: 1, endSeq: 2 });

    held.shift()?.();
    expect(shownRows()).toEqual(daemonRows);
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toMatchObject({ status: "synced", range: { endSeq: 6 } });
    owner.dispose();
  });
});
