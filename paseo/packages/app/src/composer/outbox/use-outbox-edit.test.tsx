/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { requestOutboxEdit, useOutboxStore } from "@/stores/outbox-store";
import { useOutboxEditRequests } from "./use-outbox-edit";

beforeEach(() => {
  useOutboxStore.setState({ editRequest: null });
});

test("every composer mounted for the agent shows the edit, not only the first to look", () => {
  // The same chat mounted twice (a screen under the one on show). With a consumed request the
  // hidden copy could take it and the visible composer stayed empty.
  const hidden = vi.fn();
  const visible = vi.fn();
  renderHook(() => useOutboxEditRequests({ serverId: "srv", agentId: "agent", onEdit: hidden }));
  renderHook(() =>
    useOutboxEditRequests({
      serverId: "srv",
      agentId: "agent",
      onEdit: visible,
    }),
  );
  act(() => requestOutboxEdit({ serverId: "srv", agentId: "agent" }));
  expect(hidden).toHaveBeenCalledTimes(1);
  expect(visible).toHaveBeenCalledTimes(1);
});

test("other agents' composers ignore it; each edit is applied once", () => {
  const other = vi.fn();
  const mine = vi.fn();
  renderHook(() => useOutboxEditRequests({ serverId: "srv", agentId: "other", onEdit: other }));
  const { rerender } = renderHook(() =>
    useOutboxEditRequests({ serverId: "srv", agentId: "agent", onEdit: mine }),
  );
  act(() => requestOutboxEdit({ serverId: "srv", agentId: "agent" }));
  rerender();
  expect(other).not.toHaveBeenCalled();
  expect(mine).toHaveBeenCalledTimes(1);
  act(() => requestOutboxEdit({ serverId: "srv", agentId: "agent" }));
  expect(mine).toHaveBeenCalledTimes(2);
});

test("a composer mounting after the edit does not replay it (the draft it loads has the text)", () => {
  requestOutboxEdit({ serverId: "srv", agentId: "agent" });
  const late = vi.fn();
  renderHook(() => useOutboxEditRequests({ serverId: "srv", agentId: "agent", onEdit: late }));
  expect(late).not.toHaveBeenCalled();
});
