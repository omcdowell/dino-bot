import { afterEach, describe, expect, it } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { supportsOutbox } from "./features";

const SERVER = "srv-offline";

function setSession(serverInfo: unknown): void {
  useSessionStore.getState().initializeSession(SERVER, null);
  useSessionStore.setState((state) => ({
    ...state,
    sessions: {
      ...state.sessions,
      [SERVER]: { ...state.sessions[SERVER], serverInfo } as never,
    },
  }));
}

describe("supportsOutbox", () => {
  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER);
  });

  it("uses the outbox when the daemon says it dedupes by message ID", () => {
    setSession({
      serverId: SERVER,
      hostname: null,
      version: null,
      features: { canonicalSubmittedPrompts: true },
    });
    expect(supportsOutbox(SERVER)).toBe(true);
  });

  it("keeps the old send-once path when the daemon is known to lack it", () => {
    setSession({ serverId: SERVER, hostname: null, version: null, features: {} });
    expect(supportsOutbox(SERVER)).toBe(false);
  });

  // OQ1: after an app relaunch or resume the host has not handshaken yet (no client, no
  // serverInfo). Sending must queue as a pending (clock) bubble, not fail with
  // "Host is not connected".
  it("queues in the outbox while the host has not handshaken yet (serverInfo unknown)", () => {
    setSession(null);
    expect(supportsOutbox(SERVER)).toBe(true);
  });

  it("queues in the outbox when there is no session for the host yet", () => {
    expect(supportsOutbox("srv-never-seen")).toBe(true);
  });
});
