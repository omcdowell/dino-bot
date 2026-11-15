/**
 * "Workers" (owner, 15 Nov: "claude code if signed in, pi if signed in ... have in app settings only let you change the
 * global default and say if you want more fine grained, ask your bots"). The setting lives on the host, in the bots
 * plugin's settings file (`workerEngine`); the app reads and writes it through the plugin's RPCs. Automatic: Claude
 * Code when it is signed in on the computer, else pi. A bot's own default is set by asking the bot (its .bot.json),
 * never here. A host without the bots plugin (or with an older one) does not answer the RPC: the card is hidden.
 */
export const WORKER_ENGINE_RPC = {
  pluginId: "bots",
  get: "workers.settings",
  set: "workers.settings.set",
} as const;

export type WorkerEngineChoice = "auto" | "cc" | "pi";

export const WORKER_ENGINE_TITLE = "Workers";
export const WORKER_ENGINE_HINT =
  "What your bots' workers run on by default. Automatic: Claude Code when it is signed in on this computer, else pi. For per-bot defaults, ask your bot.";

export const WORKER_ENGINE_OPTIONS: { value: WorkerEngineChoice; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "cc", label: "Claude Code" },
  { value: "pi", label: "pi" },
];

export interface WorkerEngineAnswer {
  engine: WorkerEngineChoice;
  effective: "cc" | "pi";
  claudeCode: boolean;
  pi: boolean;
}

const ENGINE_NAME = { cc: "Claude Code", pi: "pi" } as const;

/** The plugin's answer, or null when it is not one (an older plugin, another plugin's reply). */
export function parseWorkerEngineAnswer(value: unknown): WorkerEngineAnswer | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const engine = v.engine;
  const effective = v.effective;
  if (engine !== "auto" && engine !== "cc" && engine !== "pi") return null;
  if (effective !== "cc" && effective !== "pi") return null;
  return { engine, effective, claudeCode: v.claudeCode === true, pi: v.pi === true };
}

export interface WorkerEngineCardState {
  isVisible: boolean;
  value: WorkerEngineChoice;
  isDisabled: boolean;
  /** "Now: Claude Code" for Automatic; a warning when the chosen engine is not signed in. */
  statusText: string | null;
  loadingText: string | null;
  errorText: string | null;
}

export function getWorkerEngineCardState(input: {
  isConnected: boolean;
  answer: WorkerEngineAnswer | null;
  isPending: boolean;
  error: unknown;
}): WorkerEngineCardState {
  const a = input.answer;
  return {
    isVisible: input.isConnected && a !== null,
    value: a?.engine ?? "auto",
    isDisabled: input.isPending,
    statusText: a ? statusText(a) : null,
    loadingText: input.isPending ? "Saving…" : null,
    errorText: errorText(input.error),
  };
}

function statusText(a: WorkerEngineAnswer): string | null {
  if (a.engine === "auto") return `Now: ${ENGINE_NAME[a.effective]}.`;
  if (a.engine === "cc" && !a.claudeCode)
    return "Claude Code is not signed in on this computer: workers will not start until it is.";
  if (a.engine === "pi" && !a.pi)
    return "pi has no sign-in on this computer: workers will not start until it has one.";
  return null;
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}
