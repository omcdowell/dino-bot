/**
 * Settings › Providers, "Two engines" (providers redesign, option A): what the bots run on.
 *   pi           the default: its sign-ins (keys shown only as a hint) and added packages
 *   Claude Code  the user's own Claude Code login, its plan, version and the bots on it
 * The bots plugin's engines.* RPCs (plugins/bots/shared/engines-rpc.ts); host side DinoBot's
 * installer (lib/engines.mjs). Signing in reuses the setup sign-in screen (signin.start): a pi option,
 * or CLAUDE_CODE_OPTION_ID for Claude Code's own login.
 *
 * Feature gate: an older daemon answers "Unknown RPC method: engines.…"; the screen then shows the
 * older "Bot sign-ins" list (bot-providers-section.tsx).
 */
import { ONBOARDING_ROUTES } from "./onboarding-model";

export const ENGINES_RPC = {
  pluginId: "bots",
  status: "engines.status",
  piSignOut: "engines.pi-sign-out",
  claudeLogout: "engines.claude-logout",
} as const;

/** signin.start's option id for the Claude Code login (lib/engines.mjs CLAUDE_CODE_OPTION_ID). */
export const CLAUDE_CODE_OPTION_ID = "claude-code:login";

export interface PiSignIn {
  provider: string;
  plugin: string | null;
  ready: boolean;
  optionId: string | null;
  label: string;
  /** "login" | "key" | null (a plugin's provider with no sign-in yet). */
  kind: string | null;
  keyHint: string | null;
  canSignOut: boolean;
}

export interface PiCard {
  ready: boolean;
  readyCount: number;
  isDefault: boolean;
  signins: PiSignIn[];
  packages: Array<{ source: string; bundled: boolean }>;
}

export interface ClaudeCodeCard {
  installed: boolean;
  version: string | null;
  modsReady: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  plan: string | null;
  warning: string | null;
  bots: string[];
  error: string | null;
}

export interface EnginesAnswer {
  available: boolean;
  pi: PiCard | null;
  claudeCode: ClaudeCodeCard | null;
  error: string | null;
}

/** The daemon (or its bots plugin) predates engines.*: show the older Bot sign-ins list. */
export function isEnginesUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Unknown RPC method: engines\./i.test(message);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Ready · 3 sign-ins · default" / "Needs sign-in · default" / "No sign-ins yet · default". */
export function piSummary(card: PiCard): { ok: boolean; text: string } {
  const n = card.signins.filter((s) => s.kind !== null).length;
  const parts: string[] = [];
  if (card.ready) parts.push("Ready", plural(n, "sign-in", "sign-ins"));
  else parts.push(n ? "Needs sign-in" : "No sign-ins yet");
  if (card.isDefault) parts.push("default");
  return { ok: card.ready, text: parts.join(" · ") };
}

/** What a pi sign-in row shows on the right: the key hint, "signed in", or "needs sign-in". */
export function piSignInStatus(row: PiSignIn): { ok: boolean; text: string; isKey: boolean } {
  if (!row.ready) return { ok: false, text: row.kind ? "sign in again" : "needs sign-in", isKey: false };
  if (row.kind === "key") return { ok: true, text: row.keyHint ?? "key saved", isKey: true };
  return { ok: true, text: "signed in", isKey: false };
}

export type ClaudeCodeState = "not-installed" | "logged-out" | "logged-in" | "error";

export function claudeCodeState(card: ClaudeCodeCard): ClaudeCodeState {
  if (!card.installed) return "not-installed";
  if (card.error) return "error";
  return card.loggedIn ? "logged-in" : "logged-out";
}

/** "Logged in · Max plan · 1 bot" / "Not logged in" / "Not installed on your computer". */
export function claudeCodeSummary(card: ClaudeCodeCard): { ok: boolean; text: string } {
  const state = claudeCodeState(card);
  if (state === "not-installed") return { ok: false, text: "Not installed on your computer" };
  if (state === "error") return { ok: false, text: "Could not ask Claude Code" };
  if (state === "logged-out") return { ok: false, text: "Not logged in" };
  const parts = ["Logged in"];
  if (card.plan) parts.push(card.plan);
  parts.push(plural(card.bots.length, "bot", "bots"));
  return { ok: !card.warning, text: parts.join(" · ") };
}

/** The setup sign-in screen for the Claude Code login, from Settings. */
export function claudeCodeSignInRoute(serverId: string): string {
  const q = new URLSearchParams({ serverId, from: "settings", option: CLAUDE_CODE_OPTION_ID });
  return `${ONBOARDING_ROUTES.signin}?${q.toString()}`;
}

/** The setup sign-in screen showing only "Install from a link" (Add a provider package). */
export function addPackageRoute(serverId: string): string {
  const q = new URLSearchParams({ serverId, from: "settings", add: "package" });
  return `${ONBOARDING_ROUTES.signin}?${q.toString()}`;
}
