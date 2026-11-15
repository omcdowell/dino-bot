/**
 * @vitest-environment jsdom
 *
 * N-1 / N-2: Back on the first-run sign-in step stays in onboarding: to Welcome (the one under it
 * after an in-app scan, or Welcome in its place after a pasted or deep link), with the host marked
 * paused so Welcome does not bounce straight back; never router.back() to whatever is below, never
 * "/" (the bots home) with setup unfinished.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  invoke: vi.fn(),
  router: {
    replace: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    dismissTo: vi.fn(),
    canGoBack: vi.fn(() => true),
  },
  confirm: vi.fn(async () => true),
  inputs: new Map<string, (t: string) => void>(),
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
    Linking: { openURL: vi.fn() },
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
        children
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
  useRouter: () => h.router,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@/components/ui/text-input", () => ({
  EditingTextInput: ({
    onChangeText,
    testID,
  }: {
    onChangeText: (t: string) => void;
    testID?: string;
  }) => {
    if (testID) h.inputs.set(testID, onChangeText);
    return React.createElement("input", { "data-testid": testID });
  },
}));
vi.mock("@/components/headers/back-header", () => ({
  BackHeader: ({ title, onBack }: { title: string; onBack?: () => void }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": "back", onClick: onBack },
      title
    ),
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
      children
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
vi.mock("@/constants/device-copy", () => ({
  DEVICE_COPY: { thisApp: "this app" },
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({ invokePluginRpc: h.invoke }),
  }),
}));
vi.mock("@/onboarding/setup-store", () => ({
  routeAfterStep: async () => "/setup-models",
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: h.confirm }));

import SetupSignInScreen from "./setup-signin";
import { isOnboardingPaused, resetOnboardingPause } from "@/onboarding/onboarding-pause";

const OPTIONS = {
  available: true,
  options: [
    { id: "openrouter:api-key:2", provider: "openrouter", label: "OpenRouter", method: "api-key" },
  ],
  signedIn: [] as string[],
  error: null,
};
const ENGINES = {
  available: true,
  pi: null,
  claudeCode: {
    installed: true,
    version: "2.1.300",
    modsReady: true,
    loggedIn: false,
    authMethod: null,
    plan: null,
    warning: null,
    bots: [],
    error: null,
  },
  error: null,
};

let hostN = 0;
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
  await act(async () => root!.render(<SetupSignInScreen />));
  await flush();
}
let session: Record<string, unknown> | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.params = { serverId: `srv-back-${++hostN}` };
  session = null;
  resetOnboardingPause();
  for (const fn of [h.router.replace, h.router.push, h.router.back, h.router.dismissTo]) fn.mockReset();
  h.router.canGoBack.mockReset();
  h.router.canGoBack.mockReturnValue(true);
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (_p: string, method: string) => {
    if (method === "signin.options") return OPTIONS;
    if (method === "engines.status") return ENGINES;
    if (method === "signin.start" || method === "signin.status") return session;
    if (method === "signin.cancel") return { ok: true };
    throw new Error(method);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("first-run sign-in: Back stays in onboarding", () => {
  it("N-1: after an in-app scan (Welcome underneath): back to that Welcome, host paused, no bounce", async () => {
    await render();
    await act(async () => byId("back")!.click());
    expect(h.router.dismissTo).toHaveBeenCalledWith("/welcome");
    expect(h.router.back).not.toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
    expect(isOnboardingPaused(h.params.serverId)).toBe(true);
  });

  it("N-2: after a pasted or deep link (nothing underneath): Welcome, never the bots home", async () => {
    h.router.canGoBack.mockReturnValue(false);
    await render();
    await act(async () => byId("back")!.click());
    // dismissTo replaces the screen with Welcome when Welcome is not in the history.
    expect(h.router.dismissTo).toHaveBeenCalledWith("/welcome");
    expect(h.router.replace).not.toHaveBeenCalledWith("/");
    expect(h.router.back).not.toHaveBeenCalled();
    expect(isOnboardingPaused(h.params.serverId)).toBe(true);
  });

  it("Back during a sign-in only stops it (the screen stays)", async () => {
    session = {
      sessionId: "s1",
      provider: "openrouter",
      label: "OpenRouter",
      state: "needs-input",
      url: null,
      code: null,
      instructions: null,
      prompt: { kind: "key", message: "Paste your key." },
      error: null,
    };
    await render();
    await act(async () => byId("setup-signin-openrouter:api-key:2")!.click());
    await flush();
    await act(async () => byId("back")!.click());
    await flush();
    expect(h.invoke).toHaveBeenCalledWith("bots", "signin.cancel", { sessionId: "s1" });
    expect(h.router.dismissTo).not.toHaveBeenCalled();
    expect(isOnboardingPaused(h.params.serverId)).toBe(false);
  });

  it("from Settings: Back returns to Settings as before (not Welcome, not paused)", async () => {
    h.params = { ...h.params, from: "settings" };
    await render();
    await act(async () => byId("back")!.click());
    await flush();
    expect(h.router.back).toHaveBeenCalled();
    expect(h.router.dismissTo).not.toHaveBeenCalled();
    expect(isOnboardingPaused(h.params.serverId)).toBe(false);
  });
});
