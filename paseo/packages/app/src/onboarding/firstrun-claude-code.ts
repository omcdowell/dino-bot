/**
 * First-run "Sign in for your bots" (FR1, 15 Nov): Claude Code's own login first, then pi's list.
 *
 * Why: signin.options is pi's list only (lib/phone-signin.mjs PhoneSignIn.options →
 * bots/shared/sign-in.ts SIGN_IN_OPTIONS). Claude Code's login (CLAUDE_CODE_OPTION_ID, the host runs
 * `claude auth login`) was reachable only from Settings › Providers, so a Pro/Max user on first run
 * saw "Claude login (extra usage)" as the only Claude choice and could pay per token by mistake.
 *
 * The card's state comes from engines.status (the same answer the Providers page shows); the login
 * is the same signin.start(CLAUDE_CODE_OPTION_ID) flow. Without the `claude` CLI, a host that can
 * (canInstall) runs Anthropic's installer and then that login: signin.start(CLAUDE_CODE_INSTALL_ID).
 */
import { badgeIsWarning, type SignInOption } from "./onboarding-model";
import { claudeCodeState, type ClaudeCodeCard } from "./engines-model";

export const CLAUDE_CODE_FIRST_RUN_COPY = {
  /**
   * Two options (LO1, 15 Nov: "make it clear on the logins that its two options … the pi tui or
   * the cc tui that they are picking between"). TUI is said in words first ("terminal app").
   */
  choiceTitle: "Pick how your bots run: Claude Code or pi",
  choiceLead:
    "There are two options. Each is a terminal app (a program in a text window on your computer) that your bots run in. You sign in here; your computer keeps the sign-in.",
  optionOne: "Option 1",
  optionTwo: "Option 2",
  or: "or",
  recommended: "(recommended)",
  choose: "Choose",
  label: "Claude Code",
  note: "Uses your Claude Pro/Max plan",
  detail:
    "Your bots run in the Claude Code terminal app (CC TUI). Your computer logs in; no extra usage.",
  piTitle: "pi",
  piDetail:
    "Your bots run in the pi terminal app (pi TUI), signed in with one of these providers.",
  /** From Settings (pi's list only, no Claude Code card). */
  piDetailSettings: "Your bots run in the pi terminal app (pi TUI). Add one of these providers.",
  /** The Providers page's words for a computer without the `claude` CLI (engines-section.tsx). */
  install:
    "Install Claude Code on your computer first (claude.com/download), then log in here.",
  /** A host that can install it (canInstall): one button, then the login by itself. */
  installHere:
    "Not on your computer yet. One tap installs it (Anthropic's installer), then you log in.",
  installButton: "Install Claude Code",
  /** A daemon that predates engines.* (no Claude Code login there): update it first. */
  updateHost:
    "Your computer's bots service is too old for Claude Code. Update it on your computer, then Check again.",
  /** First run, while the computer says what it is signed in to (signInGate "wait"). */
  checking: "Checking what your computer is already signed in to…",
  extraUsageWarning:
    "⚠ Billed per token on top of any Claude plan you pay for.",
} as const;

export type FirstRunClaudeCode =
  /** Settings › Add a sign-in: pi's list only (Providers has its own Claude Code card). */
  | { kind: "hidden" }
  /** The host's daemon predates engines.* (and Claude Code's login): the card, asking to update. */
  | { kind: "update-host"; message: string }
  /** engines.status not answered yet: the card already works (signin.start says if claude is missing). */
  | { kind: "checking" }
  /** canInstall: the host runs Anthropic's installer ("Install Claude Code"), else only the message. */
  | { kind: "not-installed"; message: string; canInstall: boolean }
  | { kind: "logged-out" }
  | { kind: "error"; message: string }
  | { kind: "logged-in"; status: string };

/** What the first-run Claude Code card shows, from engines.status's Claude Code card. */
export function firstRunClaudeCode(input: {
  unsupported: boolean;
  card: ClaudeCodeCard | null | undefined;
}): FirstRunClaudeCode {
  // The old pi-only first-run screen is gone (15 Nov): first run always shows both options.
  if (input.unsupported)
    return { kind: "update-host", message: CLAUDE_CODE_FIRST_RUN_COPY.updateHost };
  const card = input.card;
  if (!card) return { kind: "checking" };
  const state = claudeCodeState(card);
  if (state === "not-installed")
    return card.canInstall
      ? {
          kind: "not-installed",
          message: CLAUDE_CODE_FIRST_RUN_COPY.installHere,
          canInstall: true,
        }
      : {
          kind: "not-installed",
          message: CLAUDE_CODE_FIRST_RUN_COPY.install,
          canInstall: false,
        };
  if (state === "error")
    return {
      kind: "error",
      message: card.error ?? "Could not ask Claude Code.",
    };
  if (state === "logged-out") return { kind: "logged-out" };
  // Not claudeCodeSummary's text: "· 0 bots" means nothing on first run.
  return { kind: "logged-in", status: card.plan ? `Logged in · ${card.plan}` : "Logged in" };
}

/** Pressing the card starts Claude Code's login (not when it is missing or already logged in). */
export function claudeCodeCardPressable(cc: FirstRunClaudeCode): boolean {
  return (
    cc.kind === "checking" || cc.kind === "logged-out" || cc.kind === "error"
  );
}

/** The Claude login billed as extra usage (not the API key, not the plan-via-plugin wording). */
export function isExtraUsageLogin(option: SignInOption): boolean {
  return (
    option.provider === "anthropic" &&
    option.method !== "api-key" &&
    badgeIsWarning(option) &&
    /extra usage/i.test(option.badge ?? "")
  );
}

/** One-line warning under the extra-usage Claude login, else null. */
export function extraUsageWarning(option: SignInOption): string | null {
  return isExtraUsageLogin(option)
    ? CLAUDE_CODE_FIRST_RUN_COPY.extraUsageWarning
    : null;
}

/** pi's list with every confirm-first Claude login at the bottom (stable otherwise). */
export function orderPiOptions(
  options: readonly SignInOption[]
): SignInOption[] {
  const last = (o: SignInOption) =>
    o.provider === "anthropic" && badgeIsWarning(o) ? 1 : 0;
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => last(a.o) - last(b.o) || a.i - b.i)
    .map(({ o }) => o);
}

/** "Already signed in: …" with Claude Code added when its login is there. */
export function signedInWithClaudeCode(
  signedIn: readonly string[],
  cc: FirstRunClaudeCode
): string[] {
  const label = CLAUDE_CODE_FIRST_RUN_COPY.label;
  if (cc.kind !== "logged-in" || signedIn.includes(label)) return [...signedIn];
  return [label, ...signedIn];
}

/**
 * Whether the first-run sign-in step shows at all (SR2, 20 Nov: after pairing again to a computer whose bots already
 * work, "why am i being asked to login when i already am logged in"). Signed in already = pi has a ready sign-in
 * (signin.options `signedIn`) or Claude Code is logged in, its own login or the owner's proxy (engines.status):
 * the step is done, so it is skipped ("skip"). Until both answers are in, "wait" (the screen shows a short check,
 * not the list). A real first-time user (nothing signed in) gets the list as before ("show").
 *
 * Always "show": from Settings, a sign-in asked for by name (`option`), a sign-in going, `pick` (the user came
 * back to the list on purpose: Back from Choose models, or Choose models found no models), a list that did not
 * load, a host without DinoBot's setup, and once the list was shown (`shown`: adding another account after one
 * sign-in must not jump away).
 */
export type SignInGate = "wait" | "skip" | "show";

export function signInGate(input: {
  firstRun: boolean;
  pick: boolean;
  shown: boolean;
  sessionActive: boolean;
  loadError: boolean;
  options: { available: boolean; signedIn: readonly string[] } | null;
  claudeCode: FirstRunClaudeCode;
  /** engines.status answered or failed (a failure leaves the card "checking"). */
  claudeCodeChecked: boolean;
}): SignInGate {
  if (!input.firstRun || input.pick || input.shown || input.sessionActive || input.loadError) return "show";
  if (!input.options) return "wait";
  if (!input.options.available) return "show";
  if (input.options.signedIn.length) return "skip";
  if (input.claudeCode.kind === "logged-in") return "skip";
  if (input.claudeCode.kind === "checking" && !input.claudeCodeChecked) return "wait";
  return "show";
}
