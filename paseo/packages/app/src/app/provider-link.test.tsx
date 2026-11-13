/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  hosts: [] as Array<{ serverId: string; label: string }>,
  rpc: vi.fn(),
  replace: vi.fn(),
  copied: [] as string[],
}));

vi.mock("react-native", () => {
  const el =
    (tag: string) =>
    ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(tag, { "data-testid": testID }, children);
  return {
    View: el("div"),
    ScrollView: el("div"),
    Text: el("span"),
    Pressable: ({
      children,
      onPress,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      React.createElement(
        "button",
        { type: "button", "data-testid": testID, onClick: onPress },
        children,
      ),
  };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (C: unknown) => C,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => h.params,
  useRouter: () => ({ replace: h.replace, push: vi.fn(), back: vi.fn() }),
}));
vi.mock("expo-clipboard", () => ({
  setStringAsync: async (s: string) => void h.copied.push(s),
}));
vi.mock("lucide-react-native", () => ({ Copy: () => null }));
vi.mock("@/components/headers/back-header", () => ({
  BackHeader: ({ title }: { title: string }) => React.createElement("h1", null, title),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, disabled, onClick: onPress },
      children,
    ),
}));
vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => null,
}));
vi.mock("@/constants/flavour", () => ({
  APP_DISPLAY_NAME: "DinoBot",
  APP_LINK_SCHEME: "dinobot",
}));
vi.mock("@/constants/layout", () => ({ setupColumnStyle: {} }));
vi.mock("@/constants/platform", () => ({ isNative: false }));
vi.mock("@/runtime/host-runtime", () => ({ useHosts: () => h.hosts }));
vi.mock("@/onboarding/bots-rpc", () => ({ botsRpc: h.rpc }));

import ProviderLinkScreen from "./provider-link";

const TOKEN = "github_pat_TEST_000000000000";
const LINK = `dinobot://provider/add?source=${encodeURIComponent(
  "git:github.com/acme/claude-plugin@v1",
)}&name=Acme+Claude&token=${TOKEN}`;
const CLAUDE = {
  provider: "anthropic",
  plugin: "Acme Claude",
  ready: false,
  optionId: "anthropic:oauth:3",
  label: "Claude login (your plan, via Acme Claude)",
};
const job = (over: Record<string, unknown>) => ({
  jobId: "j1",
  source: "git:https://github.com/acme/claude-plugin@v1",
  name: "Acme Claude",
  state: "running",
  step: "installing",
  error: null,
  providers: [],
  ...over,
});

let root: Root | null = null;
let container: HTMLElement | null = null;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
const byId = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ProviderLinkScreen />));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.params = { link: LINK };
  h.hosts = [{ serverId: "mac", label: "Mac" }];
  h.rpc.mockReset();
  h.replace.mockReset();
  h.copied = [];
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("provider link screen", () => {
  it("asks the one paired computer, installs there with the link's token, shows progress, then goes straight to the sign-in", async () => {
    h.rpc.mockImplementation(async (_s: string, method: string) => {
      if (method === "provider.list")
        return { available: true, packages: [], providers: [], error: null };
      if (method === "provider.install") return job({});
      if (method === "provider.install-status")
        return job({ state: "done", step: "done", providers: [CLAUDE] });
      throw new Error(method);
    });
    await render();
    expect(container!.textContent).toContain("Install on Mac?");
    expect(container!.textContent).not.toContain(TOKEN);
    await act(async () => byId("provider-link-install")!.click());
    await flush();
    expect(h.rpc).toHaveBeenCalledWith("mac", "provider.install", {
      source: "git:github.com/acme/claude-plugin@v1",
      token: TOKEN,
      name: "Acme Claude",
    });
    expect(byId("provider-link-progress")!.textContent).toContain("Downloading");
    await act(async () => vi.advanceTimersByTime(1000));
    await flush();
    expect(h.replace).toHaveBeenCalledWith(
      "/setup-signin?serverId=mac&from=settings&option=anthropic%3Aoauth%3A3",
    );
  });

  it("ready at once (already signed in): says so, no sign-in", async () => {
    h.rpc.mockImplementation(async (_s: string, method: string) => {
      if (method === "provider.list")
        return { available: true, packages: [], providers: [], error: null };
      return job({
        state: "done",
        step: "done",
        providers: [{ ...CLAUDE, ready: true }],
      });
    });
    await render();
    await act(async () => byId("provider-link-install")!.click());
    await flush();
    expect(byId("provider-link-done")!.textContent).toContain("ready");
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("shows the computer's error", async () => {
    h.rpc.mockImplementation(async (_s: string, method: string) => {
      if (method === "provider.list")
        return { available: true, packages: [], providers: [], error: null };
      return job({ state: "error", error: "Could not add it: *** expired" });
    });
    await render();
    await act(async () => byId("provider-link-install")!.click());
    await flush();
    expect(byId("provider-link-error")!.textContent).toContain("expired");
  });

  it("an old daemon (no provider.*) gets the copy-the-command fallback, no install button", async () => {
    h.rpc.mockRejectedValue(new Error("Unknown RPC method: provider.list"));
    await render();
    expect(byId("provider-link-install")).toBeNull();
    expect(byId("provider-link-fallback")).not.toBeNull();
    await act(async () => byId("provider-link-copy")!.click());
    await flush();
    expect(h.copied[0]).toMatch(/^dinobot provider add 'dinobot:\/\/provider\/add\?/);
  });

  it("several computers: pick one first", async () => {
    h.hosts = [
      { serverId: "mac", label: "Mac" },
      { serverId: "box", label: "Box" },
    ];
    h.rpc.mockResolvedValue({
      available: true,
      packages: [],
      providers: [],
      error: null,
    });
    await render();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("Which computer?");
    await act(async () => byId("provider-link-host-box")!.click());
    await flush();
    expect(h.rpc).toHaveBeenCalledWith("box", "provider.list", {});
    expect(container!.textContent).toContain("Install on Box?");
  });

  it("a broken link says so", async () => {
    h.params = { link: "dinobot://provider/add?name=x" };
    await render();
    expect(byId("provider-link-invalid")).not.toBeNull();
  });
});
