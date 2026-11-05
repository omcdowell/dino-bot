/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLinks, LinkRow, NetworkStatus } from "@/screens/network-status/model";
import { CONNECTION_FAULT_DEBOUNCE_MS, useConnectionFault } from "./use-connection-fault";

let status: NetworkStatus;

vi.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => status,
}));
vi.mock("@/stores/outbox-store", () => ({
  useOutboxStore: (select: (state: { records: unknown[] }) => unknown) =>
    select({
      records: [
        { serverId: "host-1", state: "outbox" },
        { serverId: "host-1", state: "taken" },
      ],
    }),
}));

const okPhone: LinkRow = {
  id: "phone",
  state: "ok",
  reason: "phoneOnline",
  latencyMs: null,
  lastOkAt: null,
};

function hostWithDaemon(state: LinkRow["state"], reason: string): HostLinks {
  return {
    serverId: "host-1",
    label: "box",
    route: "direct",
    rows: [{ id: "daemon", state, reason, latencyMs: null, lastOkAt: null }],
    rtt: { medianMs: null, p95Ms: null, lossPct: null, samples: 0 },
    run: null,
  } as unknown as HostLinks;
}

function setDaemon(state: LinkRow["state"], reason: string) {
  status = { phone: okPhone, hosts: [hostWithDaemon(state, reason)] };
}

describe("useConnectionFault", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDaemon("ok", "daemonOnline");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out a short blip, then shows the fault with the waiting count", () => {
    const { result, rerender } = renderHook(() => useConnectionFault("host-1"));
    setDaemon("down", "daemonReconnecting");
    rerender();
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(CONNECTION_FAULT_DEBOUNCE_MS));
    expect(result.current).toMatchObject({
      link: "daemon",
      reason: "daemonReconnecting",
      waiting: 1,
    });
  });

  it("stays up while the reason changes between reconnect attempts", () => {
    const { result, rerender } = renderHook(() => useConnectionFault("host-1"));
    setDaemon("down", "daemonReconnecting");
    rerender();
    act(() => vi.advanceTimersByTime(CONNECTION_FAULT_DEBOUNCE_MS));
    setDaemon("down", "daemonOfflineWithError");
    rerender();
    expect(result.current?.reason).toBe("daemonOfflineWithError");
  });

  it("hides as soon as the link is back", () => {
    const { result, rerender } = renderHook(() => useConnectionFault("host-1"));
    setDaemon("down", "daemonReconnecting");
    rerender();
    act(() => vi.advanceTimersByTime(CONNECTION_FAULT_DEBOUNCE_MS));
    setDaemon("ok", "daemonOnline");
    rerender();
    expect(result.current).toBeNull();
    setDaemon("down", "daemonReconnecting");
    rerender();
    expect(result.current).toBeNull();
  });
});
