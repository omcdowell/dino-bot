import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Settings › Providers, "Two engines" (providers redesign, option A): what the bots run on.
 *   pi           the default; its sign-ins (pi's auth.json in DinoBot's pi dir) and added packages
 *   Claude Code  the user's own Claude Code login (Claude Code's own store; DinoBot never holds it)
 * Host side: DinoBot's installer (lib/engines.mjs through lib/phone-signin.mjs createOnboarding).
 * Signing in uses signin.start: a pi option id, or "claude-code:login" for Claude Code.
 *
 * Keys never come back: an API key is shown only as `keyHint` (its public prefix and last 4
 * characters, computed on the computer).
 *
 * Feature gate: an older daemon answers "Unknown RPC method: engines.…"; the app then shows the
 * older "Bot sign-ins" list (provider.list). `available` is false on a plain Paseo host.
 */

const PiSignInSchema = z.object({
  provider: z.string(),
  plugin: z.string().nullable(),
  ready: z.boolean(),
  optionId: z.string().nullable(),
  label: z.string(),
  /** "login" (a plan's OAuth), "key" (an API key), or null (a plugin's provider, no sign-in yet). */
  kind: z.string().nullable(),
  /** API keys only: "sk-or-…4f2a", "$OPENROUTER_API_KEY", "from a command" or "••••". */
  keyHint: z.string().nullable(),
  canSignOut: z.boolean(),
});
export type PiSignIn = z.infer<typeof PiSignInSchema>;

const ClaudeCodeSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  /** The version has the mods OptChat needs (>= 2.1.287). */
  modsReady: z.boolean(),
  loggedIn: z.boolean(),
  authMethod: z.string().nullable(),
  /** "Max plan", "Pro plan", "API key", … */
  plan: z.string().nullable(),
  /** e.g. a Team/Enterprise login, where OptChat cannot run. */
  warning: z.string().nullable(),
  /** Bots running on Claude Code now (the CC-OptChat host's registry). */
  bots: z.array(z.string()),
  error: z.string().nullable(),
});
export type ClaudeCodeCard = z.infer<typeof ClaudeCodeSchema>;

export const enginesStatusRpc = defineRpc({
  name: "engines.status",
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    pi: z
      .object({
        ready: z.boolean(),
        readyCount: z.number(),
        isDefault: z.boolean(),
        signins: z.array(PiSignInSchema),
        packages: z.array(z.object({ source: z.string(), bundled: z.boolean() })),
      })
      .nullable(),
    claudeCode: ClaudeCodeSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const enginesPiSignOutRpc = defineRpc({
  name: "engines.pi-sign-out",
  /** pi's provider id ("openrouter", "openai-codex", …): its entry leaves auth.json. */
  input: z.object({ provider: z.string().max(64) }),
  output: z.object({ removed: z.string() }),
});

export const enginesClaudeLogoutRpc = defineRpc({
  name: "engines.claude-logout",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});
