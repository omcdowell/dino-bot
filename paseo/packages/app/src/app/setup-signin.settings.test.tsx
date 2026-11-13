/**
 * @vitest-environment jsdom
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
    canGoBack: () => true,
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

const OPTIONS = {
  available: true,
  options: [
    {
      id: "openai-codex:oauth:0",
      provider: "openai-codex",
      label: "ChatGPT",
      method: "oauth",
    },
    {
      id: "anthropic:oauth:3",
      provider: "anthropic",
      label: "Claude login (your plan, via Acme Claude)",
      method: "oauth",
      badge: "UNOFFICIAL",
      confirm: {
        title: "Claude login through Acme Claude",
        body: "…",
        ok: "Continue",
      },
    },
  ],
  signedIn: ["ChatGPT (Codex)"],
  error: null,
};
const session = (state: string) => ({
  sessionId: "s1",
  provider: "anthropic",
  label: "Claude",
  state,
  url: "https://claude.ai/oauth",
  code: null,
  instructions: null,
  prompt: state === "needs-input" ? { kind: "code", message: "Paste the code" } : null,
  error: null,
});

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

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.invoke.mockReset();
  h.router.replace.mockReset();
  h.router.push.mockReset();
  h.router.back.mockReset();
  h.confirm.mockClear();
  h.inputs.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("sign-in from Settings (outside onboarding)", () => {
  it("with an option (after installing Acme Claude): confirm sheet, then that sign-in starts at once; Done goes back to Settings", async () => {
    h.params = {
      serverId: "srvA",
      from: "settings",
      option: "anthropic:oauth:3",
    };
    h.invoke.mockImplementation(
      async (_p: string, method: string, input: { optionId?: string }) => {
        if (method === "signin.options") return OPTIONS;
        if (method === "signin.start") {
          expect(input).toEqual({
            optionId: "anthropic:oauth:3",
            confirmed: true,
          });
          return session("done");
        }
        throw new Error(method);
      },
    );
    await render();
    expect(container!.textContent).toContain("Add a sign-in");
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(byId("setup-signin-done")).not.toBeNull();
    const done = byId("setup-signin-continue")!;
    expect(done.textContent).toBe("Done");
    await act(async () => done.click());
    await flush();
    expect(h.router.back).toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled(); // not on to the onboarding's next step
  });

  it("without an option: every built-in sign-in, no 'Continue with this', plus install from a link", async () => {
    h.params = { serverId: "srvB", from: "settings" };
    h.invoke.mockResolvedValue(OPTIONS);
    await render();
    expect(byId("setup-signin-openai-codex:oauth:0")).not.toBeNull();
    expect(byId("setup-signin-anthropic:oauth:3")).not.toBeNull();
    expect(byId("setup-signin-skip")).toBeNull();
    expect(byId("setup-signin-install-link")).not.toBeNull();
    const open = byId("setup-signin-install-link-open") as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    await act(async () =>
      h.inputs.get("setup-signin-install-link-input")!("dinobot://provider/add?source=npm:pi-x"),
    );
    await act(async () => byId("setup-signin-install-link-open")!.click());
    expect(h.router.push).toHaveBeenCalledWith(
      "/provider-link?link=dinobot%3A%2F%2Fprovider%2Fadd%3Fsource%3Dnpm%253Api-x&serverId=srvB",
    );
  });

  it("onboarding is unchanged: no install-from-link card, and the skip button is there", async () => {
    h.params = { serverId: "srvC" };
    h.invoke.mockResolvedValue(OPTIONS);
    await render();
    expect(container!.textContent).toContain("Sign in for your bots");
    expect(byId("setup-signin-install-link")).toBeNull();
    expect(byId("setup-signin-skip")).not.toBeNull();
  });
});
