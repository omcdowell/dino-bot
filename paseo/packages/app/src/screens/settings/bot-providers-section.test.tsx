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
  return { View: el("div"), Text: el("span") };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  useUnistyles: () => ({
    theme: { colors: { statusSuccess: "g", statusWarning: "y" } },
  }),
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

import { BotProvidersSection } from "./bot-providers-section";

const LIST = {
  available: true,
  packages: [
    { source: "npm:pi-web-access", bundled: true },
    { source: "git:https://github.com/acme/claude-plugin@v1", bundled: false },
  ],
  providers: [
    {
      provider: "openai-codex",
      plugin: null,
      ready: true,
      optionId: "openai-codex:oauth:0",
      label: "ChatGPT",
    },
    {
      provider: "anthropic",
      plugin: "Acme Claude",
      ready: false,
      optionId: "anthropic:oauth:3",
      label: "Claude login (your plan, via Acme Claude)",
    },
  ],
  error: null,
};

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
  await act(async () => root!.render(<BotProvidersSection serverId="mac" />));
  await flush();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.rpc.mockReset();
  h.push.mockReset();
  h.confirm.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("Settings → Providers: bot sign-ins", () => {
  it("shows each provider ready or needing sign-in, with Sign in buttons that open the sign-in outside onboarding", async () => {
    h.rpc.mockResolvedValue(LIST);
    await render();
    expect(byId("bot-provider-openai-codex")!.textContent).toContain("Ready");
    const claude = byId("bot-provider-anthropic")!.textContent;
    expect(claude).toContain("Needs sign-in");
    expect(claude).toContain("via Acme Claude");
    await act(async () => byId("bot-provider-signin-anthropic")!.click());
    expect(h.push).toHaveBeenCalledWith(
      "/setup-signin?serverId=mac&from=settings&option=anthropic%3Aoauth%3A3",
    );
    // Only added packages are listed (bundled ones are not removable).
    expect(byId("bot-package-npm:pi-web-access")).toBeNull();
    expect(byId("bot-package-git:https://github.com/acme/claude-plugin@v1")).not.toBeNull();
  });

  it("Add a provider opens the full sign-in list (built-ins + install from a link)", async () => {
    h.rpc.mockResolvedValue(LIST);
    await render();
    await act(async () => byId("bot-providers-add")!.click());
    expect(h.push).toHaveBeenCalledWith("/setup-signin?serverId=mac&from=settings");
  });

  it("removes an added package after confirming", async () => {
    h.rpc.mockImplementation(async (_s: string, method: string) =>
      method === "provider.remove" ? { removed: "x" } : LIST,
    );
    await render();
    await act(async () =>
      byId("bot-package-remove-git:https://github.com/acme/claude-plugin@v1")!.click(),
    );
    await flush();
    expect(h.confirm).toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledWith("mac", "provider.remove", {
      source: "git:https://github.com/acme/claude-plugin@v1",
    });
  });

  it("hidden on an old daemon and on a host without DinoBot", async () => {
    h.rpc.mockRejectedValue(new Error("Unknown RPC method: provider.list"));
    await render();
    expect(container!.textContent).toBe("");
    act(() => root?.unmount());
    container?.remove();
    h.rpc.mockReset();
    h.rpc.mockResolvedValue({ ...LIST, available: false });
    await render();
    expect(container!.textContent).toBe("");
  });
});
