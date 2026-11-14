/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  confirm: vi.fn(async () => true),
}));

vi.mock("react-native", () => {
  const el =
    (tag: string) =>
    ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(tag, { "data-testid": testID }, children);
  const Pressable = ({
    children,
    testID,
    onPress,
  }: {
    children?: React.ReactNode;
    testID?: string;
    onPress?: () => void;
  }) => React.createElement("div", { "data-testid": testID, onClick: onPress }, children);
  return { View: el("div"), Text: el("span"), Pressable };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useRouter: () => ({ push: h.push }),
    useFocusEffect: (cb: () => void) => useEffect(cb, [cb]),
  };
});
vi.mock("@/styles/settings", () => ({ settingsStyles: {} }));
vi.mock("@/components/settings/headings/settings-section", () => ({
  SettingsSection: ({ children, title }: { children?: React.ReactNode; title: string }) =>
    React.createElement("section", { "data-title": title }, children),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
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
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: h.confirm }));
vi.mock("@/onboarding/bots-rpc", () => ({ botsRpc: h.rpc }));
vi.mock("@/utils/host-routes", () => ({
  buildNewWorkspaceRoute: ({ serverId }: { serverId: string }) => `/new?serverId=${serverId}`,
}));
vi.mock("@/screens/settings/bot-providers-section", () => ({
  BotProvidersSection: () => React.createElement("div", { "data-testid": "legacy-bot-signins" }),
}));

import { EnginesSection } from "./engines-section";

const STATUS = {
  available: true,
  error: null,
  pi: {
    ready: true,
    readyCount: 2,
    isDefault: true,
    signins: [
      {
        provider: "openai-codex",
        plugin: null,
        ready: true,
        optionId: "openai-codex:device-code:0",
        label: "ChatGPT (Codex)",
        kind: "login",
        keyHint: null,
        canSignOut: true,
      },
      {
        provider: "openrouter",
        plugin: null,
        ready: true,
        optionId: "openrouter:api-key:2",
        label: "OpenRouter",
        kind: "key",
        keyHint: "sk-or-…4f2a",
        canSignOut: true,
      },
      {
        provider: "anthropic",
        plugin: null,
        ready: false,
        optionId: "anthropic:paste-code:5",
        label: "Claude login (extra usage)",
        kind: "login",
        keyHint: null,
        canSignOut: true,
      },
    ],
    packages: [
      { source: "npm:pi-web-access", bundled: true },
      { source: "git:https://github.com/acme/claude-plugin@v1", bundled: false },
    ],
  },
  claudeCode: {
    installed: true,
    version: "2.1.323",
    modsReady: true,
    loggedIn: true,
    authMethod: "claude.ai",
    plan: "Max plan",
    warning: null,
    bots: ["tweety"],
    error: null,
  },
};

let root: Root | null = null;
let container: HTMLElement | null = null;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
const byId = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const onAvailability = vi.fn();
async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<EnginesSection serverId="mac" onAvailabilityChange={onAvailability} />),
  );
  await flush();
}
const click = async (id: string) => {
  await act(async () => byId(id)!.click());
  await flush();
};

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.rpc.mockReset();
  h.push.mockReset();
  h.confirm.mockClear();
  onAvailability.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("Settings → Providers: two engines", () => {
  it("pi card: summary, each sign-in, keys only as a hint, added packages only", async () => {
    h.rpc.mockResolvedValue(STATUS);
    await render();
    expect(h.rpc).toHaveBeenCalledWith("mac", "engines.status", {});
    expect(onAvailability).toHaveBeenCalledWith(true);
    expect(byId("engine-pi-status")!.textContent).toBe("Ready · 3 sign-ins · default");
    expect(byId("engine-pi-signin-openai-codex")!.textContent).toContain("signed in");
    expect(byId("engine-pi-key-openrouter")!.textContent).toBe("sk-or-…4f2a");
    // A sign-in pi says is not ready shows its buttons at once.
    expect(byId("engine-pi-signin-anthropic")!.textContent).toContain("sign in again");
    expect(byId("engine-pi-signin-btn-anthropic")!.textContent).toBe("Sign in");
    expect(byId("engine-pi-package-npm:pi-web-access")).toBeNull();
    expect(byId("engine-pi-package-git:https://github.com/acme/claude-plugin@v1")).not.toBeNull();
    // The pi card comes before the Claude Code card.
    const html = container!.innerHTML;
    expect(html.indexOf("engine-pi")).toBeLessThan(html.indexOf("engine-claude-code"));
  });

  it("pi: sign in again opens that sign-in outside onboarding", async () => {
    h.rpc.mockResolvedValue(STATUS);
    await render();
    expect(byId("engine-pi-signin-btn-openrouter")).toBeNull(); // folded until tapped
    await click("engine-pi-row-openrouter");
    expect(byId("engine-pi-signin-btn-openrouter")!.textContent).toBe("Sign in again");
    await click("engine-pi-signin-btn-openrouter");
    expect(h.push).toHaveBeenCalledWith(
      "/setup-signin?serverId=mac&from=settings&option=openrouter%3Aapi-key%3A2",
    );
  });

  it("pi: sign out after confirming, then reloads", async () => {
    h.rpc.mockImplementation(async (_s: string, method: string) =>
      method === "engines.pi-sign-out" ? { removed: "openrouter" } : STATUS,
    );
    await render();
    await click("engine-pi-row-openrouter");
    await click("engine-pi-signout-openrouter");
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sign out of OpenRouter?", destructive: true }),
    );
    expect(h.rpc).toHaveBeenCalledWith("mac", "engines.pi-sign-out", { provider: "openrouter" });
    expect(h.rpc.mock.calls.filter((c) => c[1] === "engines.status")).toHaveLength(2);
  });

  it("pi: nothing is signed out without the yes", async () => {
    h.rpc.mockResolvedValue(STATUS);
    h.confirm.mockResolvedValueOnce(false);
    await render();
    await click("engine-pi-row-openrouter");
    await click("engine-pi-signout-openrouter");
    expect(h.rpc).not.toHaveBeenCalledWith("mac", "engines.pi-sign-out", expect.anything());
  });

  it("pi: a failed sign-out shows the computer's error", async () => {
    h.rpc.mockImplementation(async (_s: string, method: string) => {
      if (method === "engines.pi-sign-out") throw new Error("openrouter is not signed in");
      return STATUS;
    });
    await render();
    await click("engine-pi-row-openrouter");
    await click("engine-pi-signout-openrouter");
    expect(byId("engines-error")!.textContent).toBe("openrouter is not signed in");
  });

  it("pi: no sign-ins yet", async () => {
    h.rpc.mockResolvedValue({
      ...STATUS,
      pi: { ...STATUS.pi, ready: false, readyCount: 0, signins: [], packages: [] },
    });
    await render();
    expect(byId("engine-pi-status")!.textContent).toBe("No sign-ins yet · default");
    await click("engine-pi-first-signin");
    expect(h.push).toHaveBeenCalledWith("/setup-signin?serverId=mac&from=settings");
  });

  it("Add and Other tools rows", async () => {
    h.rpc.mockResolvedValue(STATUS);
    await render();
    await click("engines-add-signin");
    expect(h.push).toHaveBeenLastCalledWith("/setup-signin?serverId=mac&from=settings");
    await click("engines-add-package");
    expect(h.push).toHaveBeenLastCalledWith(
      "/setup-signin?serverId=mac&from=settings&add=package",
    );
    await click("engines-terminal");
    expect(h.push).toHaveBeenLastCalledWith("/new?serverId=mac");
  });

  it("Claude Code card: logged in, plan, bots, version; log out after confirming", async () => {
    h.rpc.mockImplementation(async (_s: string, method: string) =>
      method === "engines.claude-logout" ? { ok: true } : STATUS,
    );
    await render();
    expect(byId("engine-claude-status")!.textContent).toBe("Logged in · Max plan · 1 bot");
    expect(byId("engine-claude-bots")!.textContent).toBe("tweety");
    expect(byId("engine-claude-mods")!.textContent).toBe("mods ready");
    expect(byId("engine-claude-login")).toBeNull();
    await click("engine-claude-logout");
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Log out of Claude Code?" }),
    );
    expect(h.rpc).toHaveBeenCalledWith("mac", "engines.claude-logout", {});
  });

  it("Claude Code card: not logged in opens Claude Code's own login on the sign-in screen", async () => {
    h.rpc.mockResolvedValue({
      ...STATUS,
      claudeCode: { ...STATUS.claudeCode, loggedIn: false, plan: null, bots: [] },
    });
    await render();
    expect(byId("engine-claude-status")!.textContent).toBe("Not logged in");
    expect(byId("engine-claude-bots")!.textContent).toBe("None yet");
    await click("engine-claude-login");
    expect(h.push).toHaveBeenCalledWith(
      "/setup-signin?serverId=mac&from=settings&option=claude-code%3Alogin",
    );
  });

  it("Claude Code card: not installed says what to do; an old version asks for an update", async () => {
    h.rpc.mockResolvedValue({
      ...STATUS,
      claudeCode: { ...STATUS.claudeCode, installed: false, loggedIn: false, version: null },
    });
    await render();
    expect(byId("engine-claude-status")!.textContent).toBe("Not installed on your computer");
    expect(byId("engine-claude-install")).not.toBeNull();
    expect(byId("engine-claude-login")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    h.rpc.mockResolvedValue({
      ...STATUS,
      claudeCode: { ...STATUS.claudeCode, version: "2.1.100", modsReady: false },
    });
    await render();
    expect(byId("engine-claude-mods")!.textContent).toBe("update for mods");
  });

  it("an older daemon gets the Bot sign-ins list; a host without DinoBot, nothing", async () => {
    h.rpc.mockRejectedValue(new Error("Unknown RPC method: engines.status"));
    await render();
    expect(byId("legacy-bot-signins")).not.toBeNull();
    expect(byId("engine-pi")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    h.rpc.mockReset();
    h.rpc.mockResolvedValue({ available: false, pi: null, claudeCode: null, error: null });
    await render();
    expect(container!.textContent).toBe("");
    expect(onAvailability).toHaveBeenLastCalledWith(false);
  });
});
