import type { ReleasePolicy } from "@/constants/flavour";

/**
 * First-run setup after pairing (public flavour): which Claude plan the user is on (sets the
 * default bot model) and the optional chat import. Pure; the screen is src/app/setup.tsx.
 *
 * The host does the work through the bots plugin (proposed RPCs, see SETUP_RPC). An older plugin
 * without them only means the step is skipped: the app never blocks on it.
 */

/**
 * Main-bot model per sign-in. Mirrors the `main` column of pi-optchat `src/model-defaults.ts`
 * (release/import); keep the two in step. Claude logins cannot tell Pro from Max, so the plan
 * comes from the "I'm on Max" switch (ReleasePolicy.claudePlanDefault until it is touched).
 */
export const MAIN_MODEL_BY_SIGN_IN = {
  "claude-pro": "anthropic/claude-sonnet-5-5",
  "claude-max": "anthropic/claude-opus-5-5",
  "anthropic-api": "anthropic/claude-sonnet-5-5",
  chatgpt: "openai-codex/gpt-6-sol",
  "openai-api": "openai/gpt-6-sol",
  copilot: "github-copilot/claude-sonnet-5.5",
  openrouter: "openrouter/anthropic/claude-sonnet-5.5",
} as const;

export type SignInId = keyof typeof MAIN_MODEL_BY_SIGN_IN;
export type ClaudePlan = "pro" | "max";

/** The sign-in row for a host's sign-in, with Claude logins split by the chosen plan. */
export function signInRow(signIn: string | null | undefined, plan: ClaudePlan): SignInId | null {
  if (!signIn) return null;
  if (signIn === "claude" || signIn === "claude-pro" || signIn === "claude-max") {
    return plan === "max" ? "claude-max" : "claude-pro";
  }
  return signIn in MAIN_MODEL_BY_SIGN_IN ? (signIn as SignInId) : null;
}

export function defaultBotModel(
  signIn: string | null | undefined,
  plan: ClaudePlan,
): string | null {
  const row = signInRow(signIn, plan);
  return row ? MAIN_MODEL_BY_SIGN_IN[row] : null;
}

/** What the host's import scan returns (pi-optchat `cli.ts scan --json`, trimmed). */
export interface ImportEstimate {
  messages: number;
  calls: number;
  tokens: number;
  hours: number;
  usd?: { low: number; mid: number; high: number };
  /** Share of a weekly plan allowance; a guess, shown only when the policy allows. */
  weeklyShare?: number;
  model: string;
  billing: "api" | "plan" | "requests" | "free";
  label: string;
}

export interface SetupState {
  claudePlan: ClaudePlan;
  importEnabled: boolean;
  /** null = everything. */
  importDays: number | null;
  includeScratch: boolean;
}

export function initialSetupState(policy: ReleasePolicy): SetupState {
  return {
    claudePlan: policy.claudePlanDefault,
    importEnabled: policy.importDefaultOn,
    importDays: policy.importDefaultDays,
    includeScratch: !policy.importUntickScratch,
  };
}

function millions(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${Math.round(n / 1000)}k`;
}
function dollars(n: number): string {
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}
function duration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** Copy shown before the switch is turned on, when there is no estimate yet. */
export const IMPORT_INTRO =
  "Your bots can read your past chats with coding agents on this computer, so they start out knowing your projects. This uses your model sign-in and runs in the background.";

/**
 * The cost warning (rel-import `warning()`), with the "% of a weekly limit" line only when
 * `showPlanPercent` (the plan allowances are guesses; rec 22 drops it).
 */
export function importWarning(e: ImportEstimate, options: { showPlanPercent: boolean }): string {
  const lines = [
    `Importing your old chats will use a lot of your ${e.billing === "api" ? "API credit" : "subscription"}.`,
    `${e.messages.toLocaleString("en-US")} messages → about ${millions(e.tokens)} tokens with ${e.model} (${e.calls.toLocaleString("en-US")} model calls).`,
  ];
  if (e.billing === "free") {
    lines.push(
      "It is free, but free models are rate limited, so it may take days. It pauses at each limit and carries on later.",
    );
  } else if (e.usd && e.billing === "plan") {
    lines.push(
      options.showPlanPercent && e.weeklyShare !== undefined
        ? `That is roughly ${Math.round(e.weeklyShare * 100)}% of a weekly ${e.label} limit (${dollars(e.usd.mid)} at API prices). It pauses when you hit a limit and carries on later.`
        : `That is about ${dollars(e.usd.mid)} at API prices, taken from your plan's limits. It pauses when you hit a limit and carries on later.`,
    );
  } else if (e.usd && e.billing === "requests") {
    lines.push(
      `It uses a model included in your plan; at API prices it would be about ${dollars(e.usd.mid)}.`,
    );
  } else if (e.usd) {
    lines.push(
      `That is about ${dollars(e.usd.mid)} on your API bill (could be ${dollars(e.usd.low)}–${dollars(e.usd.high)}).`,
    );
  } else {
    lines.push("The price of this model is unknown, so no cost is shown.");
  }
  lines.push(
    `It runs in the background for about ${duration(e.hours)}; your bot works meanwhile and gets the old chats when it finishes. You can pause it or untick projects.`,
  );
  return lines.join("\n");
}

/** Bots-plugin RPCs the setup step calls (proposed contract for the plugin side). */
export const SETUP_RPC = {
  pluginId: "bots",
  /** in: { days: number | null, includeScratch: boolean } → { signIn?: string, estimate?: ImportEstimate } */
  scan: "setup.import-scan",
  /** in: SetupRequest → { ok: boolean }. Starts the import detached; returns at once. */
  apply: "setup.apply",
} as const;

export interface SetupRequest {
  claudePlan: ClaudePlan;
  /** Default model for new bots; null leaves the host's own default. */
  defaultBotModel: string | null;
  import: { days: number | null; includeScratch: boolean } | null;
}

export function buildSetupRequest(state: SetupState, signIn: string | null): SetupRequest {
  return {
    claudePlan: state.claudePlan,
    defaultBotModel: defaultBotModel(signIn, state.claudePlan),
    import: state.importEnabled
      ? { days: state.importDays, includeScratch: state.includeScratch }
      : null,
  };
}

/** Pairing goes through setup once per host, only where the policy has the step. */
export function needsSetup(
  policy: ReleasePolicy,
  doneServerIds: readonly string[],
  serverId: string,
) {
  return policy.importOnboarding && !doneServerIds.includes(serverId);
}
