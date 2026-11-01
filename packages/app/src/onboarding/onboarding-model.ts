/**
 * Onboarding after pairing (public flavour). The order of the steps is ONE list,
 * ReleasePolicy.onboardingSteps in constants/flavour.ts (Emmet's order for the demo, 27 Oct;
 * The owner reviews it): sign in → choose models → import past chats. DinoBot's installer has the
 * matching switch (installer lib/flow.mjs SETUP_FLOW) for steps that can move back to the terminal.
 *
 * The host does the work through the bots plugin RPCs below; pi is the infrastructure: pi-ai's
 * logins and auth.json, `pi auth check`, pi's model list (get_available_models after
 * `pi update --models`) and each model's thinkingLevelMap. The app keeps no list of its own.
 */
export type OnboardingStep = "signin" | "models" | "import";

export const ONBOARDING_ROUTES: Record<OnboardingStep, string> = {
  signin: "/setup-signin",
  models: "/setup-models",
  import: "/setup",
};

export const ONBOARDING_RPC = {
  pluginId: "bots",
  signinOptions: "signin.options",
  signinStart: "signin.start",
  signinSubmit: "signin.submit",
  signinStatus: "signin.status",
  signinCancel: "signin.cancel",
  models: "setup.models",
  apply: "setup.apply",
} as const;

/** The route of `step` for `serverId`. */
export function stepRoute(step: OnboardingStep, serverId: string): string {
  return `${ONBOARDING_ROUTES[step]}?serverId=${encodeURIComponent(serverId)}`;
}

/** The step after `current` in `steps`, or null when onboarding is over. */
export function nextStep(
  steps: readonly OnboardingStep[],
  current: OnboardingStep | null,
): OnboardingStep | null {
  if (current === null) return steps[0] ?? null;
  const i = steps.indexOf(current);
  return i >= 0 ? (steps[i + 1] ?? null) : null;
}

/** The step before `current` in `steps`, or null. */
export function previousStep(
  steps: readonly OnboardingStep[],
  current: OnboardingStep,
): OnboardingStep | null {
  const i = steps.indexOf(current);
  return i > 0 ? (steps[i - 1] ?? null) : null;
}

export interface SignInOption {
  id: string;
  provider: string;
  label: string;
  method: string;
  note?: string;
  badge?: string;
  /** Shown as a sheet before the login starts; the user must confirm (Claude: EXTRA USAGE). */
  confirm?: { title: string; body: string; ok: string };
}

/**
 * A sign-in option's badge is a warning when the option needs a confirm first (the Claude login:
 * EXTRA USAGE, or UNOFFICIAL when a provider plugin on the host routes it through the Claude plan).
 * The wording is the host's; the app does not match badge texts.
 */
export function badgeIsWarning(option: Pick<SignInOption, "badge" | "confirm">): boolean {
  return Boolean(option.badge && option.confirm);
}

export interface SignInStatus {
  sessionId: string;
  provider: string;
  label: string;
  state: "running" | "needs-input" | "done" | "error" | string;
  url: string | null;
  code: string | null;
  instructions: string | null;
  prompt: { kind: "code" | "key" | string; message: string } | null;
  error: string | null;
}

export type ModelRole = "bots" | "compaction" | "workers";
export const MODEL_ROLES: readonly ModelRole[] = ["bots", "compaction", "workers"];
export const ROLE_COPY: Record<ModelRole, { title: string; hint: string }> = {
  bots: { title: "Bots", hint: "The bots you chat with." },
  compaction: {
    title: "Compaction",
    hint: "Keeps each bot's memory short. Called often: pick a cheap, fast one.",
  },
  workers: { title: "Herdr subagents", hint: "Workers your bots start for longer jobs." },
};

export interface PiModel {
  provider: string;
  id: string;
  name: string;
  /** Effort levels pi says this model supports ([] = none: no effort picker). */
  levels: string[];
}
export interface ModelPick {
  provider: string;
  model: string;
  thinking: string | null;
}
export type ModelPicks = Record<ModelRole, ModelPick | null>;

export interface ModelsAnswer {
  available: boolean;
  providers: string[];
  subscription: string | null;
  models: PiModel[];
  suggested: ModelPicks;
  current: ModelPicks;
  error: string | null;
}

export function samePick(a: ModelPick | null, b: ModelPick | null): boolean {
  if (!a || !b) return a === b;
  return a.provider === b.provider && a.model === b.model && a.thinking === b.thinking;
}

export function findModel(models: readonly PiModel[], pick: ModelPick | null): PiModel | null {
  if (!pick) return null;
  return models.find((m) => m.provider === pick.provider && m.id === pick.model) ?? null;
}

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The closest effort `model` supports (pi-ai's clampThinkingLevel), or null if it has none. */
export function clampEffort(model: PiModel, wanted: string | null): string | null {
  if (!model.levels.length) return null;
  if (wanted && model.levels.includes(wanted)) return wanted;
  const i = LEVEL_ORDER.indexOf(wanted ?? "medium");
  for (let j = i; j >= 0 && j < LEVEL_ORDER.length; j++) {
    if (model.levels.includes(LEVEL_ORDER[j]!)) return LEVEL_ORDER[j]!;
  }
  for (let j = i - 1; j >= 0; j--)
    if (model.levels.includes(LEVEL_ORDER[j]!)) return LEVEL_ORDER[j]!;
  return model.levels[0] ?? null;
}

/** Picking a new model keeps the effort if it can, else the closest the new model supports. */
export function pickModel(model: PiModel, previous: ModelPick | null): ModelPick {
  return {
    provider: model.provider,
    model: model.id,
    thinking: clampEffort(model, previous?.thinking ?? null),
  };
}

/** Prefill: what the host already has, else the suggestion; both only if pi lists the model. */
export function initialPicks(answer: ModelsAnswer): ModelPicks {
  const out = {} as ModelPicks;
  for (const role of MODEL_ROLES) {
    const pick =
      [answer.current[role], answer.suggested[role]].find((p) => findModel(answer.models, p)) ??
      null;
    const model = findModel(answer.models, pick);
    out[role] = model && pick ? { ...pick, thinking: clampEffort(model, pick.thinking) } : null;
  }
  return out;
}

/** Search in the model list: name, id or provider; models of the signed-in providers only. */
export function filterModels(models: readonly PiModel[], query: string): PiModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(q));
}
