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
  BackHeader: ({ title }: { title: string }) =>
    React.createElement("h1", null, title),
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

const EXTRA = {
  id: "anthropic:paste-code:5",
  provider: "anthropic",
  label: "Claude login (extra usage)",
  method: "paste-code",
  note: "Billed to your Claude extra usage, per token.",
  badge: "EXTRA USAGE",
  confirm: {
    title: "Claude login uses EXTRA USAGE",
    body: "…",
    ok: "Continue with Claude",
  },
};
const OPTIONS = {
  available: true,
  // The extra-usage login is not last here on purpose: the app moves it down.
  options: [
    {
      id: "openai-codex:device-code:0",
      provider: "openai-codex",
      label: "ChatGPT (Codex)",
      method: "device-code",
    },
    EXTRA,
    {
      id: "openrouter:api-key:2",
      provider: "openrouter",
      label: "OpenRouter",
      method: "api-key",
    },
  ],
  signedIn: [] as string[],
  error: null,
};
const cc = (over: Record<string, unknown> = {}) => ({
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
    ...over,
  },
  error: null,
});
const ccSession = (state: string) => ({
  sessionId: "s1",
  provider: "claude-code",
  label: "Claude Code",
  state,
  url: "https://claude.ai/oauth/authorize?x=1",
  code: null,
  instructions: "Sign in with your Claude account on the page.",
  prompt:
    state === "needs-input"
      ? { kind: "code", message: "Paste the code the Claude page shows." }
      : null,
  error: null,
});

let hostN = 0;
let root: Root | null = null;
let container: HTMLElement | null = null;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
const byId = (id: string) =>
  container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const order = () =>
  [
    ...container!.querySelectorAll<HTMLElement>(
      "[data-testid^='setup-signin-']"
    ),
  ]
    .map((e) => e.dataset.testid!)
    .filter(
      (id) =>
        id === "setup-signin-claude-code" ||
        OPTIONS.options.some((o) => `setup-signin-${o.id}` === id)
    );
async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<SetupSignInScreen />));
  await flush();
}
function host(
  engines: unknown,
  extra: (method: string, input: Record<string, unknown>) => unknown = () =>
    undefined
) {
  h.invoke.mockImplementation(
    async (_p: string, method: string, input: Record<string, unknown>) => {
      if (method === "signin.options") return OPTIONS;
      if (method === "engines.status") {
        if (engines instanceof Error) throw engines;
        return engines;
      }
      const r = extra(method, input);
      if (r === undefined) throw new Error(method);
      return r;
    }
  );
}

beforeEach(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // A fresh host per test: the screen's sign-in memory is kept per server id.
  h.params = { serverId: `srv-${++hostN}` };
  h.invoke.mockReset();
  h.router.replace.mockReset();
  h.confirm.mockClear();
  h.inputs.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("first run: Sign in for your bots", () => {
  it("Claude Code first ('uses your Claude Pro/Max plan'), then pi's list with the extra-usage login last and warned", async () => {
    host(cc());
    await render();
    expect(container!.textContent).toContain("Sign in for your bots");
    const card = byId("setup-signin-claude-code")!;
    expect(card.textContent).toContain("Claude Code");
    expect(card.textContent).toContain("Uses your Claude Pro/Max plan");
    expect(order()).toEqual([
      "setup-signin-claude-code",
      "setup-signin-openai-codex:device-code:0",
      "setup-signin-openrouter:api-key:2",
      `setup-signin-${EXTRA.id}`,
    ]);
    expect(byId("setup-signin-pi-heading")).not.toBeNull();
    expect(byId(`setup-signin-${EXTRA.id}-warning`)!.textContent).toContain(
      "Billed per token on top of any Claude plan"
    );
    expect(byId("setup-signin-openai-codex:device-code:0-warning")).toBeNull();
  });

  it("pressing it runs Claude Code's own login (no extra-usage sheet), the pasted code goes to the computer, Continue goes on", async () => {
    host(cc(), (method, input) => {
      if (method === "signin.start") {
        expect(input).toEqual({
          optionId: "claude-code:login",
          confirmed: false,
        });
        return ccSession("needs-input");
      }
      if (method === "signin.submit") {
        expect(input).toEqual({ sessionId: "s1", text: "abc#def" });
        return ccSession("done");
      }
      return undefined;
    });
    await render();
    await act(async () => byId("setup-signin-claude-code")!.click());
    await flush();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(byId("setup-signin-session")!.textContent).toContain("Claude Code");
    await act(async () => h.inputs.get("setup-signin-input")!("abc#def"));
    const submit = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Continue"
    )!;
    await act(async () => submit.click());
    await flush();
    expect(byId("setup-signin-done")).not.toBeNull();
    await act(async () => byId("setup-signin-continue")!.click());
    await flush();
    expect(h.router.replace).toHaveBeenCalledWith("/setup-models");
  });

  it("the extra-usage login still asks first", async () => {
    host(cc());
    await render();
    h.confirm.mockResolvedValueOnce(false);
    await act(async () => byId(`setup-signin-${EXTRA.id}`)!.click());
    await flush();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls.some((c) => c[1] === "signin.start")).toBe(
      false
    );
  });

  it("no claude CLI on the computer: the card stays, with the Providers page's install line and Check again", async () => {
    let installed = false;
    h.invoke.mockImplementation(async (_p: string, method: string) => {
      if (method === "signin.options") return OPTIONS;
      if (method === "engines.status")
        return cc({ installed, version: installed ? "2.1.300" : null });
      throw new Error(method);
    });
    await render();
    const card = byId("setup-signin-claude-code")!;
    expect(card.tagName).toBe("DIV"); // not pressable
    expect(byId("setup-signin-claude-code-install")!.textContent).toContain(
      "claude.com/download"
    );
    installed = true;
    await act(async () => byId("setup-signin-claude-code-check")!.click());
    await flush();
    expect(byId("setup-signin-claude-code-install")).toBeNull();
    expect(byId("setup-signin-claude-code")!.tagName).toBe("BUTTON");
  });

  it("already logged in to Claude Code: shown on the card and as signed in, so 'Continue with this' is there", async () => {
    host(cc({ loggedIn: true, plan: "Max plan" }));
    await render();
    expect(byId("setup-signin-claude-code-status")!.textContent).toContain(
      "Logged in · Max plan"
    );
    expect(container!.textContent).toContain(
      "✓ Already signed in: Claude Code"
    );
    await act(async () => byId("setup-signin-skip")!.click());
    await flush();
    expect(h.router.replace).toHaveBeenCalledWith("/setup-models");
  });

  it("an older daemon (no engines.*): no Claude Code card, pi's list as before", async () => {
    host(new Error("Unknown RPC method: engines.status"));
    await render();
    expect(byId("setup-signin-claude-code")).toBeNull();
    expect(byId("setup-signin-pi-heading")).toBeNull();
    expect(byId("setup-signin-openai-codex:device-code:0")).not.toBeNull();
  });

  it("engines.status failing otherwise: the card is still there and usable", async () => {
    host(new Error("timeout"));
    await render();
    expect(byId("setup-signin-claude-code")!.tagName).toBe("BUTTON");
  });

  it("from Settings (Add a sign-in): pi's list only, no engines.status call", async () => {
    h.params = { serverId: "srv2", from: "settings" };
    host(cc());
    await render();
    expect(byId("setup-signin-claude-code")).toBeNull();
    expect(h.invoke.mock.calls.some((c) => c[1] === "engines.status")).toBe(
      false
    );
  });
});

describe("Install Claude Code: one button, then the login by itself", () => {
  const inst = (
    state: string,
    phase: string,
    over: Record<string, unknown> = {}
  ) => ({
    ...ccSession(state),
    url: phase === "login" && state !== "running" ? ccSession(state).url : null,
    instructions: phase === "login" ? ccSession(state).instructions : null,
    prompt:
      phase === "login" && state === "needs-input"
        ? ccSession(state).prompt
        : null,
    phase,
    progress:
      phase === "install" ? "Downloading 2.1.323" : "Claude Code is installed.",
    ...over,
  });
  afterEach(() => vi.useRealTimers());
  const tick = async () => {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
  };

  it("not installed: the card's button reads Install Claude Code; tap → 1 installing → 2 log in (no extra tap) → 3 done", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const polls = [inst("running", "install"), inst("needs-input", "login")];
    host(
      cc({ installed: false, canInstall: true, version: null }),
      (method, input) => {
        if (method === "signin.start") {
          expect(input).toEqual({
            optionId: "claude-code:install",
            confirmed: false,
          });
          return inst("running", "install");
        }
        if (method === "signin.status")
          return polls.shift() ?? inst("needs-input", "login");
        if (method === "signin.submit") {
          expect(input).toEqual({ sessionId: "s1", text: "good" });
          return inst("done", "login");
        }
        return undefined;
      }
    );
    await render();
    const btn = byId("setup-signin-claude-code-install-button")!;
    expect(btn.textContent).toBe("Install Claude Code");
    await act(async () => btn.click());
    await flush();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(byId("setup-signin-step-1-current")).not.toBeNull();
    expect(byId("setup-signin-step-2-todo")).not.toBeNull();
    expect(byId("setup-signin-progress")!.textContent).toBe(
      "Downloading 2.1.323"
    );
    await tick();
    expect(byId("setup-signin-step-1-current")).not.toBeNull();
    await tick();
    expect(byId("setup-signin-step-1-done")).not.toBeNull();
    expect(byId("setup-signin-step-2-current")).not.toBeNull();
    expect(byId("setup-signin-progress")).toBeNull();
    expect(byId("setup-signin-input")).not.toBeNull(); // the login, started by the host itself
    const starts = h.invoke.mock.calls.filter(
      (c) => c[1] === "signin.start"
    ).length;
    expect(starts).toBe(1);
    await act(async () => h.inputs.get("setup-signin-input")!("good"));
    const submit = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Continue"
    )!;
    await act(async () => submit.click());
    await flush();
    expect(byId("setup-signin-step-3-done")).not.toBeNull();
    expect(byId("setup-signin-done")).not.toBeNull();
  });

  it("the install fails: a plain message and Try again (the same one button)", async () => {
    let n = 0;
    host(
      cc({ installed: false, canInstall: true, version: null }),
      (method) => {
        if (method === "signin.start") {
          n++;
          return n === 1
            ? inst("error", "install", {
                error:
                  "The Claude Code installer stopped (exit 7): no network. Try again.",
              })
            : inst("running", "install");
        }
        return undefined;
      }
    );
    await render();
    await act(async () =>
      byId("setup-signin-claude-code-install-button")!.click()
    );
    await flush();
    expect(byId("setup-signin-step-1-failed")).not.toBeNull();
    expect(byId("setup-signin-error")!.textContent).toContain("no network");
    await act(async () => byId("setup-signin-try-again")!.click());
    await flush();
    expect(n).toBe(2);
    expect(byId("setup-signin-step-1-current")).not.toBeNull();
  });

  it("an older host (no canInstall): no install button, the claude.com/download line", async () => {
    host(cc({ installed: false, version: null }));
    await render();
    expect(byId("setup-signin-claude-code-install-button")).toBeNull();
    expect(byId("setup-signin-claude-code-install")!.textContent).toContain(
      "claude.com/download"
    );
  });

  it("from Settings › Providers (option=claude-code:install): starts at once, titled Install Claude Code", async () => {
    h.params = {
      serverId: "srv3",
      from: "settings",
      option: "claude-code:install",
    };
    host(cc(), (method, input) => {
      if (method === "signin.start") {
        expect(input).toEqual({
          optionId: "claude-code:install",
          confirmed: false,
        });
        return inst("running", "install");
      }
      return undefined;
    });
    await render();
    expect(container!.textContent).toContain("Install Claude Code");
    expect(byId("setup-signin-steps")).not.toBeNull();
    expect(byId("setup-signin-claude-code")).toBeNull();
  });
});
