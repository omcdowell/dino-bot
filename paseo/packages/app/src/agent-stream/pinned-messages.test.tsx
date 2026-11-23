/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/contexts/toast-context";
import {
  setOutboxBackingStorageForTests,
  useOutboxStore,
  type OutboxRecord,
} from "@/stores/outbox-store";
import { useSessionStore } from "@/stores/session-store";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createUserMessage } from "@/types/stream";
import { PinnedMessages, resolvePinnedMeta } from "./pinned-messages";

void testI18n;

// Untranspiled JSX/Flow that cannot load under vitest; the user bubble never renders markdown.
vi.mock("react-native-markdown-display", () => ({ default: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
// The shared lucide stub lacks several icons these components draw; any icon renders nothing.
vi.mock("lucide-react-native", () => {
  const Icon = () => null;
  return new Proxy(
    { __esModule: true },
    {
      get: (target, key) => {
        if (key in target) return Reflect.get(target, key);
        // Not a thenable, or awaiting the module would hang.
        if (key === "then") return undefined;
        return Icon;
      },
      has: () => true,
    },
  );
});
// Pulls in a Flow-typed native module; these bubbles carry no images.
vi.mock("@/chat-images/chat-image", () => ({ ChatImage: () => null, LocalChatImage: () => null }));
// The unistyles test stub's theme has no syntax palette; code blocks are not under test.
vi.mock("@/styles/syntax-token-styles", () => ({
  syntaxTokenStyles: {},
  syntaxTokenStyleFor: () => undefined,
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

/**
 * The real bubble and react-native-web's real Pressable: the bug is in how its press responder
 * treats a held press and a right-click on a queued bubble, which a mocked Pressable cannot show.
 * Sam, 2026-10-11: "long pressing on a queued message doesnt bring up the menu, only a tap does".
 */

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";

function queuedRecord(): OutboxRecord {
  return {
    serverId: SERVER_ID,
    agentId: AGENT_ID,
    clientMessageId: "msg-1",
    text: "queued hello",
    images: [],
    attachments: [],
    composerAttachments: [],
    activeTurnBehavior: "queue",
    createdAt: Date.UTC(2026, 9, 11, 6, 0),
    attempts: 0,
    everOnWire: false,
    nextAttemptAt: 0,
    state: "outbox",
  };
}

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}
const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  useOutboxStore.setState({ records: [] });
});

function mountPinned(records: OutboxRecord[] = [queuedRecord()]) {
  useOutboxStore.setState({ records });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <PinnedMessages serverId={SERVER_ID} agentId={AGENT_ID} />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  );
  mounted.push({ root, container });
  const bubble = () => {
    const node = container.querySelector('[data-testid="user-message"] [role="button"]');
    if (!(node instanceof HTMLElement)) throw new Error("queued bubble is not pressable");
    return node;
  };
  const actionsOpen = () =>
    container.querySelector('[data-testid="pinned-message-actions"]') !== null;
  return { bubble, actionsOpen };
}

function centre(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
}

function mouse(node: HTMLElement, type: "mousedown" | "mouseup") {
  node.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "mousedown" ? 1 : 0,
      ...centre(node),
    }),
  );
}

function wait(ms: number) {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

describe("PinnedMessages queued bubble", () => {
  it("opens its actions on a tap, and a second tap closes them", () => {
    const view = mountPinned();
    expect(view.actionsOpen()).toBe(false);
    act(() => view.bubble().click());
    expect(view.actionsOpen()).toBe(true);
    act(() => view.bubble().click());
    expect(view.actionsOpen()).toBe(false);
  });

  it("opens its actions while the press is still held (long-press)", async () => {
    const view = mountPinned();
    const bubble = view.bubble();
    act(() => mouse(bubble, "mousedown"));
    await wait(700);
    expect(view.actionsOpen()).toBe(true);
    // Releasing after the long press must not toggle it shut again.
    act(() => {
      mouse(bubble, "mouseup");
      bubble.click();
    });
    expect(view.actionsOpen()).toBe(true);
  });

  it("keeps its actions open when one hold also fires the browser contextmenu", async () => {
    const view = mountPinned();
    const bubble = view.bubble();
    act(() => mouse(bubble, "mousedown"));
    await wait(700);
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => bubble.dispatchEvent(contextMenu));
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(view.actionsOpen()).toBe(true);
  });

  it("opens its actions on a right-click instead of the browser menu (desktop)", () => {
    const view = mountPinned();
    const bubble = view.bubble();
    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      ...centre(bubble),
    });
    act(() => bubble.dispatchEvent(contextMenu));
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(view.actionsOpen()).toBe(true);
  });
});

describe("PinnedMessages taken bubble after a daemon restart", () => {
  // Sam, 2026-10-13 (build 32): a message the agent took at 20:05 stayed pinned under the
  // chat with blue ticks after the 20:07 daemon restart and a re-import, because the replayed
  // timeline has no client message IDs to settle it by.
  const sentAt = Date.parse("2026-10-13T12:05:14Z");
  function takenRecord(): OutboxRecord {
    return {
      ...queuedRecord(),
      clientMessageId: "cmid-taken",
      text: "once's thats done send the build",
      createdAt: sentAt,
      sentAt,
      attempts: 2,
      everOnWire: true,
      state: "taken",
    };
  }

  beforeEach(() => {
    const saved = new Map<string, string>();
    setOutboxBackingStorageForTests({
      getItem: async (key) => saved.get(key) ?? null,
      setItem: async (key, value) => {
        saved.set(key, value);
      },
    });
    useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
  });
  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("leaves the pinned list once the replayed row with the same text is in the stream", () => {
    useSessionStore.getState().setAgentStreamTail(
      SERVER_ID,
      new Map([
        [
          AGENT_ID,
          [
            createUserMessage({
              id: "row-1",
              messageId: "00c03938",
              text: "once's thats done send the build",
              timestamp: new Date(sentAt + 11_000),
            }),
          ],
        ],
      ]),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    useOutboxStore.setState({ records: [takenRecord()] });
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <PinnedMessages serverId={SERVER_ID} agentId={AGENT_ID} />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
    mounted.push({ root, container });
    expect(container.querySelector('[data-testid="pinned-messages"]')).toBeNull();
    expect(useOutboxStore.getState().records).toEqual([]);
  });

  it("offers Hide on a long-press when no row matches, and Hide clears it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    useOutboxStore.setState({ records: [takenRecord()] });
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <PinnedMessages serverId={SERVER_ID} agentId={AGENT_ID} />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
    mounted.push({ root, container });
    const bubble = container.querySelector('[data-testid="user-message"] [role="button"]');
    if (!(bubble instanceof HTMLElement)) throw new Error("taken bubble is not pressable");
    act(() => mouse(bubble, "mousedown"));
    await wait(700);
    act(() => mouse(bubble, "mouseup"));
    const actions = container.querySelector('[data-testid="pinned-message-actions"]');
    expect(actions).not.toBeNull();
    const hide = [...(actions?.querySelectorAll('[role="button"]') ?? [])].find(
      (node) => node.textContent === "Hide",
    );
    if (!(hide instanceof HTMLElement)) throw new Error("no Hide action on a taken bubble");
    await act(async () => {
      hide.click();
      await Promise.resolve();
    });
    expect(useOutboxStore.getState().records).toEqual([]);
    expect(container.querySelector('[data-testid="pinned-messages"]')).toBeNull();
  });
});

describe("PinnedMessages taken bubble whose row is older than the loaded stream (MO1)", () => {
  // 2026-11-21 (build 18): a message sent at 20:33 and taken by the bot was drawn at
  // the very bottom of the chat, under ten later bot replies. The app came back after more than
  // a page of new rows, so the catch-up jumped to the latest tail and the canonical row (with the
  // client message ID) was never in the stream to settle the bubble.
  const createdAt = Date.parse("2026-11-20T20:32:59Z");
  const sentAt = Date.parse("2026-11-20T20:33:30Z");
  function takenRecord(): OutboxRecord {
    return {
      ...queuedRecord(),
      clientMessageId: "cmid-old",
      text: "go for the recommendations",
      activeTurnBehavior: "queue",
      createdAt,
      sentAt,
      attempts: 2,
      everOnWire: true,
      state: "taken",
    };
  }
  function assistantRow(id: string, at: string) {
    return { kind: "assistant_message" as const, id, text: `reply ${id}`, timestamp: new Date(at) };
  }

  beforeEach(() => {
    const saved = new Map<string, string>();
    setOutboxBackingStorageForTests({
      getItem: async (key) => saved.get(key) ?? null,
      setItem: async (key, value) => {
        saved.set(key, value);
      },
    });
    useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
  });
  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  function render() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <PinnedMessages serverId={SERVER_ID} agentId={AGENT_ID} />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
    mounted.push({ root, container });
    return container;
  }

  it("is not drawn under replies when the loaded stream starts after it was sent", () => {
    useSessionStore.getState().setAgentStreamTail(
      SERVER_ID,
      new Map([
        [
          AGENT_ID,
          [
            assistantRow("a1", "2026-11-20T21:11:01Z"),
            createUserMessage({
              id: "row-dm",
              messageId: "m-15019",
              text: "[dm from a worker]",
              timestamp: new Date("2026-11-20T21:31:37Z"),
            }),
            assistantRow("a2", "2026-11-20T22:14:10Z"),
          ],
        ],
      ]),
    );
    useOutboxStore.setState({ records: [takenRecord()] });
    const container = render();
    expect(container.querySelector('[data-testid="pinned-messages"]')).toBeNull();
    expect(useOutboxStore.getState().records).toEqual([]);
  });

  it("stays pinned while the loaded stream reaches back past the send (row still to come)", () => {
    useSessionStore
      .getState()
      .setAgentStreamTail(
        SERVER_ID,
        new Map([
          [
            AGENT_ID,
            [
              assistantRow("a0", "2026-11-20T20:31:40Z"),
              assistantRow("a1", "2026-11-20T20:33:31Z"),
            ],
          ],
        ]),
      );
    useOutboxStore.setState({ records: [takenRecord()] });
    const container = render();
    expect(container.querySelector('[data-testid="pinned-messages"]')).not.toBeNull();
    expect(useOutboxStore.getState().records).toHaveLength(1);
  });
});

describe("PinnedMessages taken bubble with the daemon's row position (MO2)", () => {
  // Same case as MO1, settled by ID instead of time: the daemon said where the message's row is
  // (epoch e1, seq 120). The timeline ending at or past that row settles the bubble, whatever the
  // clocks say; a timeline that ends before it keeps the bubble.
  const sentAt = Date.parse("2026-11-20T20:33:30Z");
  function takenRecord(): OutboxRecord {
    return {
      ...queuedRecord(),
      clientMessageId: "cmid-row",
      text: "go for the recommendations",
      createdAt: sentAt,
      sentAt,
      attempts: 2,
      everOnWire: true,
      state: "taken",
      row: { epoch: "e1", seq: 120 },
    };
  }
  function assistantRow(id: string, at: number) {
    return { kind: "assistant_message" as const, id, text: `reply ${id}`, timestamp: new Date(at) };
  }

  beforeEach(() => {
    const saved = new Map<string, string>();
    setOutboxBackingStorageForTests({
      getItem: async (key) => saved.get(key) ?? null,
      setItem: async (key, value) => {
        saved.set(key, value);
      },
    });
    useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
  });
  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  function render(cursor: { epoch: string; startSeq: number; endSeq: number }) {
    // Rows timestamped before the send: MO1's time rule alone would keep this bubble pinned.
    useSessionStore
      .getState()
      .setAgentStreamTail(
        SERVER_ID,
        new Map([[AGENT_ID, [assistantRow("a1", sentAt - 60_000), assistantRow("a2", sentAt)]]]),
      );
    useSessionStore.getState().setAgentTimelineCursor(SERVER_ID, new Map([[AGENT_ID, cursor]]));
    useOutboxStore.setState({ records: [takenRecord()] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ToastProvider>
            <PinnedMessages serverId={SERVER_ID} agentId={AGENT_ID} />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
    mounted.push({ root, container });
    return container;
  }

  it("is not drawn once the loaded timeline reaches past its row", () => {
    const container = render({ epoch: "e1", startSeq: 150, endSeq: 190 });
    expect(container.querySelector('[data-testid="pinned-messages"]')).toBeNull();
    expect(useOutboxStore.getState().records).toEqual([]);
  });

  it("stays pinned while the loaded timeline ends before its row", () => {
    const container = render({ epoch: "e1", startSeq: 80, endSeq: 119 });
    expect(container.querySelector('[data-testid="pinned-messages"]')).not.toBeNull();
    expect(useOutboxStore.getState().records).toHaveLength(1);
  });
});

describe("resolvePinnedMeta while photos upload (UF1)", () => {
  const message = {
    key: "k",
    clientMessageId: "id-pics",
    text: "pics",
    createdAt: Date.UTC(2026, 10, 20, 14, 22),
    state: "clock" as const,
    remote: false,
    record: null,
  };
  const upload = { index: 3, count: 16, sentBytes: 512, totalBytes: 1024 };
  const t = (key: string, options?: Record<string, unknown>) => String(testI18n.t(key, options));

  it("shows which photo is going up and how far along the whole message is", () => {
    expect(resolvePinnedMeta(message, true, t, upload)).toBe("Uploading photo 3 of 16 · 15%");
  });

  it("says it waits for the connection when offline, not that it uploads", () => {
    expect(resolvePinnedMeta(message, false, t, upload)).toMatch(/^Will send when connected · /);
  });
});

describe("resolvePinnedMeta while a message is being retried (UT1)", () => {
  const record: OutboxRecord = {
    serverId: "srv",
    agentId: "agent",
    clientMessageId: "id-pic",
    text: "pic",
    images: [],
    attachments: [],
    composerAttachments: [],
    activeTurnBehavior: "queue",
    createdAt: Date.UTC(2026, 10, 20, 14, 22),
    attempts: 3,
    everOnWire: true,
    nextAttemptAt: 0,
    state: "outbox",
    lastError: "Timeout waiting for message (60000ms)",
  };
  const message = {
    key: "k",
    clientMessageId: "id-pic",
    text: "pic",
    createdAt: record.createdAt,
    state: "clock" as const,
    remote: false,
    record,
  };
  const t = (key: string, options?: Record<string, unknown>) => String(testI18n.t(key, options));

  it("says why the last attempt failed, so a retry loop does not look like a slow upload", () => {
    const upload = { index: 1, count: 1, sentBytes: 1024, totalBytes: 1024 };
    expect(resolvePinnedMeta(message, true, t, upload)).toBe(
      "Uploading photo 1 of 1 · 100% · Retrying: Timeout waiting for message (60000ms)",
    );
    expect(resolvePinnedMeta(message, true, t)).toBe(
      "Retrying: Timeout waiting for message (60000ms)",
    );
  });

  it("still says it waits for the connection when offline", () => {
    expect(resolvePinnedMeta(message, false, t)).toMatch(/^Will send when connected · /);
  });
});
