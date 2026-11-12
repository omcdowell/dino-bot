import { afterEach, describe, expect, it } from "vitest";
import type { CachedTimeline } from "@/runtime/replica-cache";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  PROVISIONAL_MAX_AGE_MS,
  clearProvisionalReply,
  decideProvisional,
  noteProvisionalReply,
  provisionalFromNotification,
  readProvisionalReply,
  type ProvisionalReply,
} from "./provisional-open";
import { createTimelineReplica, createViewedTimelineOwner } from "./viewed-timeline-sync";

const SERVER_ID = "provisional-host";
const AGENT_ID = "agent-p";
const NOTIFIED = Date.parse("2026-11-12T10:00:00.000Z");

function reply(over: Partial<ProvisionalReply> = {}): ProvisionalReply {
  return {
    serverId: SERVER_ID,
    agentId: AGENT_ID,
    text: "NOTIFY-ANSWER 1 BEGIN Paragraph 0…",
    notifiedAt: NOTIFIED,
    openedAt: NOTIFIED + 1000,
    ...over,
  };
}

function at(iso: string): Date {
  return new Date(iso);
}

describe("decideProvisional (pure reconcile rule)", () => {
  const old = { kind: "assistant_message" as const, timestamp: at("2026-11-12T09:50:00.000Z") };
  const fresh = { kind: "assistant_message" as const, timestamp: at("2026-11-12T10:00:00.000Z") };

  it("shows over a painted (stale) chat that does not hold the reply yet", () => {
    expect(
      decideProvisional({
        reply: reply(),
        synchronized: false,
        items: [old],
        now: NOTIFIED + 1500,
      }),
    ).toBe("show");
  });

  it("drops once a live reply at or after the notification is on screen", () => {
    expect(
      decideProvisional({
        reply: reply(),
        synchronized: false,
        items: [old, fresh],
        now: NOTIFIED + 1500,
      }),
    ).toBe("drop");
  });

  it("live wins: a synchronized page without the reply (deleted / rewound) drops the preview", () => {
    expect(
      decideProvisional({ reply: reply(), synchronized: true, items: [old], now: NOTIFIED + 1500 }),
    ).toBe("drop");
  });

  it("never outlives its max age", () => {
    expect(
      decideProvisional({
        reply: reply(),
        synchronized: false,
        items: [],
        now: NOTIFIED + 1000 + PROVISIONAL_MAX_AGE_MS + 1,
      }),
    ).toBe("drop");
  });
});

describe("provisionalFromNotification", () => {
  const data = { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: "w", reason: "finished" };

  it("takes the body of a finished-reply notification", () => {
    expect(
      provisionalFromNotification({ data, body: "hello", date: NOTIFIED, now: NOTIFIED + 5 }),
    ).toEqual({
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      text: "hello",
      notifiedAt: NOTIFIED,
      openedAt: NOTIFIED + 5,
    });
  });

  it("ignores permission and error notifications (their body is a prompt, not content)", () => {
    for (const reason of ["permission", "error"]) {
      expect(
        provisionalFromNotification({ data: { ...data, reason }, body: "Allow?", date: 1, now: 2 }),
      ).toBeNull();
    }
  });

  it("ignores empty bodies and foreign payloads", () => {
    expect(provisionalFromNotification({ data, body: "  ", date: 1, now: 2 })).toBeNull();
    expect(provisionalFromNotification({ data: {}, body: "x", date: 1, now: 2 })).toBeNull();
  });
});

describe("provisional store", () => {
  afterEach(() => clearProvisionalReply(SERVER_ID, AGENT_ID));

  it("keeps one preview per chat, replaced by a newer tap and cleared on drop", () => {
    noteProvisionalReply(reply({ text: "first" }));
    noteProvisionalReply(reply({ text: "second" }));
    expect(readProvisionalReply(SERVER_ID, AGENT_ID)?.text).toBe("second");
    clearProvisionalReply(SERVER_ID, AGENT_ID);
    expect(readProvisionalReply(SERVER_ID, AGENT_ID)).toBeUndefined();
  });
});

// ---- stale -> live, through the real viewed-timeline owner and session store ----------------

function row(
  id: string,
  kind: "user_message" | "assistant_message",
  text: string,
  seq: number,
  iso: string,
): StreamItem {
  return {
    kind,
    id,
    text,
    timestamp: at(iso),
    timelineCursor: { epoch: "epoch-1", seq },
  } as StreamItem;
}

function cached(): CachedTimeline {
  return {
    agentId: AGENT_ID,
    items: [
      row("u1", "user_message", "question", 1, "2026-11-12T09:49:00.000Z"),
      row("a1", "assistant_message", "old answer (later edited)", 2, "2026-11-12T09:50:00.000Z"),
      row("a2", "assistant_message", "row that the daemon deleted", 3, "2026-11-12T09:51:00.000Z"),
    ],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 3 },
    hasOlder: false,
  };
}

function ownerFor(storage: { readTimeline: () => Promise<CachedTimeline | undefined> }) {
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage: { readTimeline: storage.readTimeline, commitTimeline: () => undefined },
    prepareAgent: async () => undefined,
  });
  return createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      observe: () => ({ ready: Promise.resolve(), release: async () => undefined }),
      readCursor: () => undefined,
      fetchPage: async () => ({ hasNewer: false, endCursor: null }),
      fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });
}

describe("stale -> live reconcile (B2a)", () => {
  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
    clearProvisionalReply(SERVER_ID, AGENT_ID);
  });

  it("paints the cache, then the live page wins: edited rows updated, deleted rows gone, reply in order", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const owner = ownerFor({ readTimeline: async () => cached() });
    noteProvisionalReply(reply());
    owner.replaceVisibleAgentIds("test", [AGENT_ID]);

    await expect
      .poll(
        () =>
          selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID).status,
      )
      .toBe("painted");
    const painted = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    expect(painted.status).toBe("painted");
    if (painted.status !== "painted") throw new Error("unreachable");
    expect(painted.items.map((item) => item.id)).toEqual(["u1", "a1", "a2"]);
    expect(
      decideProvisional({
        reply: readProvisionalReply(SERVER_ID, AGENT_ID)!,
        synchronized: false,
        items: painted.items,
        now: NOTIFIED + 1500,
      }),
    ).toBe("show");

    // The daemon rewound the chat meanwhile (new epoch): a1 edited, a2 deleted, then the new reply.
    owner.applyTimelineResponse({
      requestId: "live-tail",
      agentId: AGENT_ID,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: true,
      epoch: "epoch-2",
      window: { minSeq: 1, maxSeq: 4, nextSeq: 5 },
      startCursor: { epoch: "epoch-2", seq: 1 },
      endCursor: { epoch: "epoch-2", seq: 4 },
      entries: [
        {
          provider: "mock",
          item: { type: "user_message", text: "question", messageId: "m1" },
          timestamp: "2026-11-12T09:49:00.000Z",
          seqStart: 1,
          seqEnd: 1,
        },
        {
          provider: "mock",
          item: { type: "assistant_message", text: "edited answer" },
          timestamp: "2026-11-12T09:50:00.000Z",
          seqStart: 2,
          seqEnd: 2,
        },
        {
          provider: "mock",
          item: { type: "user_message", text: "follow-up", messageId: "m2" },
          timestamp: "2026-11-12T09:55:00.000Z",
          seqStart: 3,
          seqEnd: 3,
        },
        {
          provider: "mock",
          item: { type: "assistant_message", text: "NOTIFY-ANSWER 1 BEGIN full reply END" },
          timestamp: "2026-11-12T10:00:00.000Z",
          seqStart: 4,
          seqEnd: 4,
        },
      ],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    } as never);

    const session = useSessionStore.getState().sessions[SERVER_ID];
    const live = [
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ];
    const texts = live.map((item) => ("text" in item ? item.text : item.kind));
    expect(texts).toEqual([
      "question",
      "edited answer",
      "follow-up",
      "NOTIFY-ANSWER 1 BEGIN full reply END",
    ]);
    expect(texts).not.toContain("row that the daemon deleted");
    expect(texts).not.toContain("old answer (later edited)");
    const state = selectAgentTimelineState(session, AGENT_ID);
    expect(state.status).toBe("synced");
    expect(
      decideProvisional({
        reply: readProvisionalReply(SERVER_ID, AGENT_ID)!,
        synchronized: state.status === "synced",
        items: live,
        now: NOTIFIED + 2500,
      }),
    ).toBe("drop");
    owner.dispose();
  });
});
