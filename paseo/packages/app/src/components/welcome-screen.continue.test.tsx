/**
 * @vitest-environment jsdom
 *
 * N-1: Welcome under the sign-in screen re-routed a freshly paired, online host straight back into
 * onboarding, so Back on sign-in bounced. A host the user stepped back out of (paused) is not
 * re-routed; Welcome offers "Continue setup", which resumes at the first onboarding step.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn() },
  focused: true,
  online: new Set<string>(),
  routeAfterPairing: vi.fn(async (id: string) => `/setup-signin?serverId=${id}`),
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
    Share: { share: vi.fn() },
    Pressable: ({
      children,
      onPress,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      React.createElement("button", { type: "button", "data-testid": testID, onClick: onPress }, children),
  };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  useUnistyles: () => ({
    theme: { spacing: { 6: 24 }, colors: { accentText: "#fff", accentForeground: "#fff", foreground: "#fff" } },
  }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("lucide-react-native", () => ({
  QrCode: () => null,
  Link2: () => null,
  ClipboardPaste: () => null,
  ExternalLink: () => null,
  Settings: () => null,
  Terminal: () => null,
}));
vi.mock("expo-router", () => ({ useRouter: () => h.router }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => h.focused }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    subscribeAll: () => () => undefined,
    getSnapshot: (id: string) => (h.online.has(id) ? { lastOnlineAt: "2026-11-15T00:00:00Z" } : null),
  }),
  isHostRuntimeConnected: (s: unknown) => Boolean(s),
  useHosts: () => [{ serverId: "srv-a" }],
}));
vi.mock("./add-host-modal", () => ({ AddHostModal: () => null }));
vi.mock("./add-remote-ssh-host-modal", () => ({ AddRemoteSshHostModal: () => null }));
vi.mock("./pair-link-modal", () => ({ PairLinkModal: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress, testID }: { children?: React.ReactNode; onPress?: () => void; testID?: string }) =>
    React.createElement("button", { type: "button", "data-testid": testID, onClick: onPress }, children),
}));
vi.mock("@/utils/app-version", () => ({ resolveDisplayVersion: () => "0.1.3" }));
vi.mock("@/desktop/updates/desktop-updates", () => ({ formatVersionWithPrefix: (v: string) => `v${v}` }));
vi.mock("@/utils/host-routes", () => ({ buildOpenProjectRoute: () => "/open-project" }));
vi.mock("@/components/icons/paseo-logo", () => ({ PaseoLogo: () => null }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/constants/build-profile", () => ({ isFdroidBuild: false }));
vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));
vi.mock("@/desktop/host", () => ({ isElectronRuntime: () => false }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@/constants/flavour", () => ({
  APP_INSTALL_URL: "https://example.invalid/install",
  APP_LINK_SCHEME: "dinobot",
  RELEASE_POLICY: { importOnboarding: true, tailnetOnly: true, debrand: true, desktopRemoteSsh: false },
  installCommand: (u: string) => `curl -fsSL ${u} | sh`,
}));
vi.mock("@/onboarding/setup-store", () => ({ routeAfterPairing: h.routeAfterPairing }));

import { WelcomeScreen } from "./welcome-screen";
import { pauseOnboarding, resetOnboardingPause } from "@/onboarding/onboarding-pause";

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
  await act(async () => root!.render(<WelcomeScreen />));
  await flush();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.router.replace.mockReset();
  h.routeAfterPairing.mockClear();
  h.online = new Set(["srv-a"]);
  h.focused = true;
  resetOnboardingPause();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("Welcome with a paired host", () => {
  it("a newly paired host online: straight into onboarding (as before)", async () => {
    await render();
    expect(h.routeAfterPairing).toHaveBeenCalledWith("srv-a");
    expect(h.router.replace).toHaveBeenCalledWith("/setup-signin?serverId=srv-a");
    expect(byId("welcome-continue-setup")).toBeNull();
  });

  it("N-1: the user stepped back out of sign-in: no bounce; 'Continue setup' resumes at sign-in", async () => {
    pauseOnboarding("srv-a");
    await render();
    expect(h.router.replace).not.toHaveBeenCalled();
    expect(byId("welcome-continue-setup")!.textContent).toContain("Your computer is paired.");
    // The install command is not the next step any more.
    expect(byId("welcome-install-step")).toBeNull();
    await act(async () => byId("welcome-continue-setup-button")!.click());
    await flush();
    expect(h.router.replace).toHaveBeenCalledWith("/setup-signin?serverId=srv-a");
    expect(h.router.replace).toHaveBeenCalledTimes(1);
  });

  it("no host online: the install step and pairing buttons, no 'Continue setup'", async () => {
    h.online = new Set();
    pauseOnboarding("srv-a");
    await render();
    expect(byId("welcome-continue-setup")).toBeNull();
    expect(byId("welcome-install-step")).not.toBeNull();
    expect(h.router.replace).not.toHaveBeenCalled();
  });
});
