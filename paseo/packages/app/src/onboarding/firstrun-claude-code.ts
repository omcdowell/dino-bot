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
  label: "Claude Code",
  note: "Uses your Claude Pro/Max plan",
  detail: "Claude Code's own login, run by your computer. No extra usage.",
  /** The Providers page's words for a computer without the `claude` CLI (engines-section.tsx). */
  install:
    "Install Claude Code on your computer first (claude.com/download), then log in here.",
  /** A host that can install it (canInstall): one button, then the login by itself. */
  installHere:
    "Not on your computer yet. One tap installs it (Anthropic's installer), then you log in.",
  installButton: "Install Claude Code",
  piHeading: "Or sign in through pi:",
  extraUsageWarning:
    "⚠ Billed per token on top of any Claude plan you pay for.",
} as const;

export type FirstRunClaudeCode =
  /** The host's daemon predates engines.* (and Claude Code's login): no card. */
  | { kind: "hidden" }
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
  if (input.unsupported) return { kind: "hidden" };
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
