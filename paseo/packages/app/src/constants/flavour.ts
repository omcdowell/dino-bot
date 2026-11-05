import type { OnboardingStep } from "@/onboarding/onboarding-model";
import Constants from "expo-constants";
import { debrandText } from "@/i18n/debrand";

/**
 * Build flavour from `extra.flavour` (release-flavour.js): "own" is the owner's build, "public" the
 * TestFlight build. Coding features are the same in both; the public flavour only drops
 * The owner-only parts (debug pickers, host name in the header with one host, raw model ids).
 */
export type AppFlavour = "own" | "public";

export function resolveAppFlavour(extra: { flavour?: unknown } | null | undefined): AppFlavour {
  return extra?.flavour === "public" ? "public" : "own";
}

const extra = Constants.expoConfig?.extra as
  | { flavour?: unknown; appName?: unknown; linkScheme?: unknown; installUrl?: unknown }
  | undefined;

export const APP_FLAVOUR: AppFlavour = resolveAppFlavour(extra);

export const isPublicFlavour = APP_FLAVOUR === "public";

/** Display name of this build (release-flavour.js is the one place it is set). */
export const APP_DISPLAY_NAME: string =
  typeof extra?.appName === "string" && extra.appName ? extra.appName : "Paseo";

/** URL scheme of this build: `<scheme>://pair/#offer=…` opens pairing. */
export const APP_LINK_SCHEME: string =
  typeof extra?.linkScheme === "string" && extra.linkScheme ? extra.linkScheme : "paseo";

/** Installer URL shown on the welcome screen (public flavour); null hides the install step. */
export const APP_INSTALL_URL: string | null =
  typeof extra?.installUrl === "string" && extra.installUrl ? extra.installUrl : null;

/** The one command a new user pastes into a Mac or Linux terminal. */
export function installCommand(url: string): string {
  return `curl -fsSL ${url} | sh`;
}

/**
 * Release defaults that differ per flavour. Each is one value to flip; the public values are the
 * recommendations the owner was asked about (morning-report.md, question numbers in brackets).
 */
export interface ReleasePolicy {
  /** Replace "Paseo" in user-visible text with the app name. */
  debrand: boolean;
  /** Accept relay (v2) pairing links. Off: direct / Tailscale only ("relay: not for now"). */
  relayPairing: boolean;
  /** Pair over Tailscale addresses only: LAN, .local and localhost endpoints are dropped, and the
   * manual host:port entry is hidden (privacy review 27 Oct). */
  tailnetOnly: boolean;
  /**
   * Never send the password over a direct connection to another machine unless it runs the
   * encrypted channel keyed to the daemon key from the QR (27 Oct: "why are we sending
   * passwords in plaintext?"). Off: upstream behaviour (plaintext when no key is saved).
   */
  directE2eeRequired: boolean;
  /** Network page probes (internet reachability) and the GitHub changelog fetch run only when the
   * user asks (privacy review 27 Oct). */
  networkProbesOnDemand: boolean;
  /** "What's new" reads upstream Paseo's CHANGELOG.md from GitHub. Off: no row, no fetch. */
  upstreamChangelog: boolean;
  /** Desktop app: start and manage its own daemon in ~/.paseo on launch. Off: the desktop app pairs
   * with the computer's installed server like the phone does (paste the pairing link). */
  desktopBuiltInDaemon: boolean;
  /** Desktop app: check for and install updates from upstream Paseo's GitHub releases. */
  desktopAppUpdates: boolean;
  /** Desktop app: offer "Remote host over SSH" (not Tailscale-only, so off with tailnetOnly). */
  desktopRemoteSsh: boolean;
  /** Desktop app: Settings > Integrations installs the `paseo` CLI (~/.local/bin, shell rc line). */
  desktopCliInstall: boolean;
  /** Which Claude plan a Claude login is assumed to be until "I'm on Max" is switched on [28]. */
  claudePlanDefault: "pro" | "max";
  /** Show the chat-import onboarding step at all, and whether its switch starts on [11]. */
  importOnboarding: boolean;
  importDefaultOn: boolean;
  /** Default import window in days; null = everything [21]. */
  importDefaultDays: number | null;
  /** Show the "X% of a weekly limit" line (allowances are guesses) [22]. */
  importShowPlanPercent: boolean;
  /** Untick herdr worker sessions under ~/scratch by default [24]. */
  importUntickScratch: boolean;
  /**
   * Onboarding after pairing, in order (onboarding/onboarding-model.ts). Reorder or drop entries
   * to change the setup flow; [] = straight to the host. "import" also needs importOnboarding.
   */
  onboardingSteps: readonly OnboardingStep[];
  /**
   * Ask for notification permission after the first bot reply instead of at Connect (rel-demo
   * bug 6; push-notifications/internal/prompt-gate.ts).
   */
  pushPromptAfterFirstReply: boolean;
}

export const RELEASE_POLICIES: Record<AppFlavour, ReleasePolicy> = {
  own: {
    debrand: false,
    relayPairing: true,
    tailnetOnly: false,
    directE2eeRequired: false,
    networkProbesOnDemand: false,
    upstreamChangelog: true,
    desktopBuiltInDaemon: true,
    desktopAppUpdates: true,
    desktopRemoteSsh: true,
    desktopCliInstall: true,
    claudePlanDefault: "max",
    importOnboarding: false,
    importDefaultOn: false,
    importDefaultDays: null,
    importShowPlanPercent: true,
    importUntickScratch: true,
    onboardingSteps: [],
    pushPromptAfterFirstReply: false,
  },
  public: {
    debrand: true,
    relayPairing: false,
    tailnetOnly: true,
    directE2eeRequired: true,
    networkProbesOnDemand: true,
    upstreamChangelog: false,
    desktopBuiltInDaemon: false,
    desktopAppUpdates: false,
    desktopRemoteSsh: false,
    desktopCliInstall: false,
    claudePlanDefault: "pro",
    importOnboarding: true,
    importDefaultOn: false,
    importDefaultDays: 90,
    importShowPlanPercent: false,
    importUntickScratch: true,
    // 4 sign in (on the phone) → 5 choose models → 6 import (optional, off) → first bot reply.
    onboardingSteps: ["signin", "models", "import"],
    pushPromptAfterFirstReply: true,
  },
};

export const RELEASE_POLICY: ReleasePolicy = RELEASE_POLICIES[APP_FLAVOUR];

/** A hard-coded user-visible string with the product name, de-branded in the public flavour. */
export function branded(text: string): string {
  return RELEASE_POLICY.debrand ? debrandText(text, APP_DISPLAY_NAME) : text;
}
