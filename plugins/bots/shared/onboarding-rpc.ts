import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Onboarding on the phone, after pairing (DinoBot setup steps 4–6; the order is a list in the app,
 * packages/app/src/constants/flavour.ts ONBOARDING_STEPS, and in the installer, lib/flow.mjs):
 *   signin.*      sign in for the bots (pi-ai's logins, pi's auth.json in DinoBot's pi dir)
 *   setup.models  pi's live model list for the signed-in providers + suggestions
 *   setup.apply   the chosen models (bots, compaction, herdr workers) and the optional import
 * The host side lives in DinoBot's installer (lib/phone-signin.mjs, found through DINOBOT_HOME).
 * Elsewhere (a plain Paseo host) `available` is false and the app skips the sign-in step.
 */

const SignInOptionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  method: z.string(),
  note: z.string().optional(),
  badge: z.string().optional(),
  confirm: z.object({ title: z.string(), body: z.string(), ok: z.string() }).optional(),
});

export const signinOptionsRpc = defineRpc({
  name: "signin.options",
  input: z.object({}),
  output: z.object({ available: z.boolean(), options: z.array(SignInOptionSchema), signedIn: z.array(z.string()), error: z.string().nullable() }),
});

const SignInStatusSchema = z.object({
  sessionId: z.string(),
  provider: z.string(),
  label: z.string(),
  /** running | needs-input | done | error */
  state: z.string(),
  url: z.string().nullable(),
  code: z.string().nullable(),
  instructions: z.string().nullable(),
  prompt: z.object({ kind: z.string(), message: z.string() }).nullable(),
  error: z.string().nullable(),
});
export type SignInStatus = z.infer<typeof SignInStatusSchema>;

export const signinStartRpc = defineRpc({
  name: "signin.start",
  /** `confirmed`: the user said yes on the option's confirm sheet (Claude login: EXTRA USAGE). */
  input: z.object({ optionId: z.string(), confirmed: z.boolean().default(false) }),
  output: SignInStatusSchema,
});

export const signinSubmitRpc = defineRpc({
  name: "signin.submit",
  /** The pasted code or API key. Never logged; written only to pi's auth.json (mode 600). */
  input: z.object({ sessionId: z.string(), text: z.string().max(4096) }),
  output: SignInStatusSchema,
});

export const signinStatusRpc = defineRpc({
  name: "signin.status",
  input: z.object({ sessionId: z.string() }),
  output: SignInStatusSchema,
});

export const signinCancelRpc = defineRpc({
  name: "signin.cancel",
  input: z.object({ sessionId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

const ModelPickSchema = z.object({ provider: z.string(), model: z.string(), thinking: z.string().nullable() });
export type ModelPickInput = z.infer<typeof ModelPickSchema>;

export const setupModelsRpc = defineRpc({
  name: "setup.models",
  /** `refresh`: run `pi update --models` first (once, right after sign-in). */
  input: z.object({ refresh: z.boolean().default(false) }),
  output: z.object({
    available: z.boolean(),
    providers: z.array(z.string()),
    subscription: z.string().nullable(),
    /** pi's get_available_models for the signed-in providers; levels from thinkingLevelMap ([] = no effort). */
    models: z.array(z.object({ provider: z.string(), id: z.string(), name: z.string(), levels: z.array(z.string()) })),
    suggested: z.object({ bots: ModelPickSchema.nullable(), compaction: ModelPickSchema.nullable(), workers: ModelPickSchema.nullable() }),
    current: z.object({ bots: ModelPickSchema.nullable(), compaction: ModelPickSchema.nullable(), workers: ModelPickSchema.nullable() }),
    error: z.string().nullable(),
  }),
});

export const setupImportScanRpc = defineRpc({
  name: "setup.import-scan",
  input: z.object({ days: z.number().nullable().optional(), includeScratch: z.boolean().optional() }),
  output: z.object({
    signIn: z.string().optional(),
    estimate: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const setupApplyRpc = defineRpc({
  name: "setup.apply",
  input: z.object({
    models: z.object({ bots: ModelPickSchema.nullable(), compaction: ModelPickSchema.nullable(), workers: ModelPickSchema.nullable() }).optional(),
    /** Older apps (rel-app2): the bot model only, "provider/model". */
    defaultBotModel: z.string().nullable().optional(),
    claudePlan: z.string().optional(),
    import: z.object({ days: z.number().nullable(), includeScratch: z.boolean() }).nullable().optional(),
  }),
  output: z.object({ ok: z.boolean(), applied: z.array(z.string()), error: z.string().nullable() }),
});
