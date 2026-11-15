/**
 * @vitest-environment jsdom
 *
 * N-3: a failed in-app scan shows the same Tailscale help as the deep-link /pair screen, not only
 * the error and "Scan QR code".
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  importConnectionLink: vi.fn(),
  onScan: null as null | ((r: { data: string }) => void),
  policy: { tailnetOnly: true },
}));

vi.mock("react-native", () => {
  const el =
    (tag: string) =>
    ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(tag, { "data-testid": testID }, children);
  return {
    View: el("div"),
    Text: el("span"),
    Pressable: el("button"),
  };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}), absoluteFillObject: {} },
  useUnistyles: () => ({ theme: { spacing: { 6: 24 }, colors: { foreground: "#fff" } } }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ source: "onboarding" }),
  useRouter: () => ({ replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("expo-camera", () => ({
  useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
  CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (r: { data: string }) => void }) => {
    h.onScan = onBarcodeScanned;
    return null;
  },
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ importConnectionLink: h.importConnectionLink }),
}));
vi.mock("@/utils/host-routes", () => ({
  buildHostRootRoute: (id: string) => `/h/${id}`,
  buildSettingsHostRoute: (id: string) => `/settings/${id}`,
}));
vi.mock("@/constants/platform", () => ({ isWeb: false }));
vi.mock("@/components/headers/back-header", () => ({ BackHeader: () => null }));
vi.mock("@/components/pair-link-modal", () => ({ PairLinkModal: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("button", { type: "button", "data-testid": testID }, children),
}));
vi.mock("@/onboarding/setup-store", () => ({ routeAfterPairing: vi.fn() }));
vi.mock("@/constants/flavour", () => ({
  APP_DISPLAY_NAME: "DinoBot",
  APP_LINK_SCHEME: "dinobot",
  get RELEASE_POLICY() {
    return h.policy;
  },
}));
vi.mock("@/constants/device-copy", () => ({ DEVICE_COPY: { thisDevice: "this iPhone" } }));

import PairScanScreen from "./pair-scan";
import { TAILSCALE_HELP } from "@/hosts/pair-deep-link";

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
  await act(async () => root!.render(<PairScanScreen />));
  await flush();
}
const LINK = "dinobot://pair/#offer=abc";

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.importConnectionLink.mockReset();
  h.policy = { tailnetOnly: true };
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("in-app QR scan failed (N-3)", () => {
  it("the error, the Tailscale help (as on /pair) and Scan again", async () => {
    h.importConnectionLink.mockRejectedValue(new Error("Could not reach your computer."));
    await render();
    expect(byId("pair-scan-tailscale-help")).toBeNull();
    await act(async () => h.onScan!({ data: LINK }));
    await flush();
    expect(container!.textContent).toContain("Could not reach your computer.");
    expect(byId("pair-scan-tailscale-help")!.textContent).toBe(TAILSCALE_HELP);
    expect(byId("pair-scan-again")).not.toBeNull();
  });

  it("no help in the own (not Tailscale-only) build", async () => {
    h.policy = { tailnetOnly: false };
    h.importConnectionLink.mockRejectedValue(new Error("nope"));
    await render();
    await act(async () => h.onScan!({ data: LINK }));
    await flush();
    expect(container!.textContent).toContain("nope");
    expect(byId("pair-scan-tailscale-help")).toBeNull();
  });
});
