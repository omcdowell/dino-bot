import { describe, expect, it } from "vitest";
import {
  presentTurnForConnection,
  reduceTurnLiveness,
  resolveTurnPresentation,
  TURN_LIVENESS_IDLE,
} from "./turn-liveness";

describe("turn activity", () => {
  const startedAt = new Date("2026-07-31T10:00:00.000Z");

  it("ignores a terminal event for another turn", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-2", startedAt },
    });

    expect(reduceTurnLiveness(open, { type: "stream_close", turnId: "turn-1" })).toBe(open);
  });

  it("replaces activity from an authoritative snapshot", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt },
    });

    expect(reduceTurnLiveness(open, { type: "snapshot", activeTurn: null })).toEqual(
      TURN_LIVENESS_IDLE,
    );
  });

  it("opens an autonomous turn from an authoritative snapshot", () => {
    expect(
      reduceTurnLiveness(TURN_LIVENESS_IDLE, {
        type: "snapshot",
        activeTurn: { turnId: "autonomous-turn-1", startedAt },
      }),
    ).toEqual({
      phase: "open",
      turnId: "autonomous-turn-1",
      startedAt,
      cancellationRequestId: null,
    });
  });

  it("does not let an old cancel completion clear the current request", () => {
    const first = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "cancellation_started",
      requestId: 1,
    });
    const second = reduceTurnLiveness(first, { type: "cancellation_started", requestId: 2 });

    expect(reduceTurnLiveness(second, { type: "cancellation_settled", requestId: 1 })).toBe(second);
  });

  it("keeps cancellation pending across submission-to-turn handoff", () => {
    const canceling = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "cancellation_started",
      requestId: 1,
    });

    expect(
      reduceTurnLiveness(canceling, {
        type: "stream_open",
        turn: { turnId: "turn-1", startedAt },
      }),
    ).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt,
      cancellationRequestId: 1,
    });
  });

  it("keeps submission-only activity untimed", () => {
    expect(resolveTurnPresentation(TURN_LIVENESS_IDLE, true)).toEqual({
      isActive: true,
      isCancelling: false,
      startedAt: null,
      turnId: null,
    });
  });
});

describe("a turn stored open, shown after a relaunch (G13)", () => {
  // The device copy of a turn that had just finished: written before its close landed.
  const stored = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
    type: "snapshot",
    activeTurn: { turnId: "turn-1", startedAt: new Date("2026-11-20T10:00:00.000Z") },
  });

  it("is not shown as running while the host is not connected", () => {
    expect(presentTurnForConnection(resolveTurnPresentation(stored, false), false)).toEqual({
      isActive: false,
      isCancelling: false,
      startedAt: null,
      turnId: null,
    });
  });

  it("is shown as the host says once it is connected", () => {
    const live = resolveTurnPresentation(stored, false);
    expect(presentTurnForConnection(live, true)).toBe(live);
    expect(live).toMatchObject({ isActive: true, turnId: "turn-1" });
  });

  it("leaves an idle turn as it is", () => {
    const idle = resolveTurnPresentation(TURN_LIVENESS_IDLE, false);
    expect(presentTurnForConnection(idle, false)).toBe(idle);
  });
});
