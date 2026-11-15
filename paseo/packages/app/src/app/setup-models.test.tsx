/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  invoke: vi.fn(),
  router: { replace: vi.fn(), push: vi.fn(), back: vi.fn(), canGoBack: () => true },
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
    Modal: () => null,
    FlatList: () => null,
    Pressable: ({ children, onPress, testID }: { children?: React.ReactNode; onPress?: () => void; testID?: string }) =>
      React.createElement("button", { type: "button", "data-testid": testID, onClick: onPress }, children),
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
  useRouter: () => h.router,
}));
vi.mock("@/components/ui/search-field", () => ({ SearchField: () => null }));
vi.mock("@/components/headers/back-header", () => ({
  BackHeader: ({ title }: { title: string }) => React.createElement("h1", null, title),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress, disabled, testID }: { children?: React.ReactNode; onPress?: () => void; disabled?: boolean; testID?: string }) =>
    React.createElement("button", { type: "button", "data-testid": testID, disabled, onClick: onPress }, children),
}));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/constants/layout", () => ({ setupColumnStyle: {} }));
vi.mock("@/constants/flavour", () => ({
  RELEASE_POLICY: { onboardingSteps: ["signin", "models", "import"] },
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({ invokePluginRpc: h.invoke }) }),
}));
vi.mock("@/onboarding/setup-store", () => ({ routeAfterStep: async () => "/setup?serverId=s" }));

import SetupModelsScreen from "./setup-models";

const EMPTY = {
  available: true,
  providers: [],
  subscription: null,
  models: [],
  suggested: { bots: null, compaction: null, workers: null },
  current: { bots: null, compaction: null, workers: null },
  error: null,
};

let root: Root | null = null;
let container: HTMLElement | null = null;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
const byId = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<SetupModelsScreen />));
  await flush();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.invoke.mockReset();
  h.router.replace.mockReset();
  h.router.push.mockReset();
  h.router.back.mockReset();
  h.invoke.mockImplementation(async (_p: string, method: string) => {
    if (method === "signin.options") return { signedIn: [] };
    if (method === "setup.models") return EMPTY;
    throw new Error(method);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("Choose models with no models (SR1 fix 1: no dead end)", () => {
  it("first run: 'No models yet: sign in' with Sign in and Skip for now; no bare Continue", async () => {
    h.params = { serverId: "s" };
    await render();
    expect(container!.textContent).toContain("No models yet");
    expect(container!.textContent).not.toContain("Suggested for .");
    expect(byId("setup-models-continue")).toBeNull();
    expect(byId("setup-models-bots")).toBeNull();
    await act(async () => byId("setup-models-sign-in")!.click());
    expect(h.router.replace).toHaveBeenCalledWith("/setup-signin?serverId=s");
    h.router.replace.mockReset();
    await act(async () => byId("setup-models-skip")!.click());
    await flush();
    expect(h.router.replace).toHaveBeenCalledWith("/setup?serverId=s");
  });

  it("from Settings (Bot models): titled so, Sign in opens Settings' sign-in, Back returns", async () => {
    h.params = { serverId: "s", from: "settings" };
    await render();
    expect(container!.textContent).toContain("Bot models");
    await act(async () => byId("setup-models-sign-in")!.click());
    expect(h.router.push).toHaveBeenCalledWith("/setup-signin?serverId=s&from=settings");
    await act(async () => byId("setup-models-skip")!.click());
    await flush();
    expect(h.router.back).toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("with models: the role cards and Continue, workers named Workers", async () => {
    h.params = { serverId: "s" };
    const m = { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", levels: ["low", "medium"] };
    const pick = { provider: "openai-codex", model: "gpt-5.5", thinking: "medium" };
    h.invoke.mockImplementation(async (_p: string, method: string) => {
      if (method === "signin.options") return { signedIn: ["ChatGPT (Codex)"] };
      if (method === "setup.models")
        return { ...EMPTY, providers: ["openai-codex"], models: [m], suggested: { bots: pick, compaction: pick, workers: pick } };
      throw new Error(method);
    });
    await render();
    expect(byId("setup-models-empty")).toBeNull();
    expect(byId("setup-models-continue")).not.toBeNull();
    expect(byId("setup-models-workers")!.textContent).toContain("Workers");
    expect(container!.textContent).toContain("Suggested for ChatGPT (Codex). Change any of them.");
  });
});
