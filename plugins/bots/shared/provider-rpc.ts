import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Model providers from the app, after setup (Settings → host → Providers, and a tapped
 * `<scheme>://provider/add?…` invite link). The host side is DinoBot's installer
 * (lib/provider-install.mjs through lib/phone-signin.mjs createOnboarding): the same `pi install`
 * into DinoBot's pi dir as `dinobot provider add`, no sudo.
 *
 * Feature gate: these methods are new. An older daemon answers "Unknown RPC method: provider.…",
 * which the app takes as "not supported here" (it then offers the copy-the-command fallback).
 * Old apps never call them, so nothing they see changes. `available` is false on a plain Paseo
 * host (no DINOBOT_HOME).
 *
 * The invite's token goes in provider.install's input only: it is stored 0600 on the computer and
 * never comes back in any output or error.
 */

const ProviderRowSchema = z.object({
  /** pi's provider id ("anthropic", "openai-codex", …). */
  provider: z.string(),
  /** The added package that registers it (its display name), or null for pi's own. */
  plugin: z.string().nullable(),
  /** `pi auth check` says ready. */
  ready: z.boolean(),
  /** The signin.options id that signs this provider in, or null when there is none in the list. */
  optionId: z.string().nullable(),
  label: z.string(),
});
export type ProviderRow = z.infer<typeof ProviderRowSchema>;

export const providerListRpc = defineRpc({
  name: "provider.list",
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    packages: z.array(z.object({ source: z.string(), bundled: z.boolean() })),
    providers: z.array(ProviderRowSchema),
    error: z.string().nullable(),
  }),
});

const InstallStatusSchema = z.object({
  jobId: z.string(),
  source: z.string(),
  name: z.string().nullable(),
  /** running | done | error */
  state: z.string(),
  /** installing | checking | models | done */
  step: z.string(),
  error: z.string().nullable(),
  /** After "done": the providers the package registers, each ready or with its sign-in. */
  providers: z.array(ProviderRowSchema),
});
export type InstallStatus = z.infer<typeof InstallStatusSchema>;

export const providerInstallRpc = defineRpc({
  name: "provider.install",
  /** npm:<pkg>[@ver] or git:github.com/<o>/<r>@<tag>; folders and other hosts are refused. */
  input: z.object({
    source: z.string().max(512),
    token: z.string().max(255).nullable().optional(),
    name: z.string().max(200).nullable().optional(),
  }),
  output: InstallStatusSchema,
});

export const providerInstallStatusRpc = defineRpc({
  name: "provider.install-status",
  input: z.object({ jobId: z.string() }),
  output: InstallStatusSchema,
});

export const providerRemoveRpc = defineRpc({
  name: "provider.remove",
  input: z.object({ source: z.string().max(512) }),
  output: z.object({ removed: z.string() }),
});
