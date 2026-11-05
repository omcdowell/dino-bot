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
import { PinnedMessages } from "./pinned-messages";

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
