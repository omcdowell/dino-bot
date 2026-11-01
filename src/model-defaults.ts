import type { ModelChoice } from './compactor.ts';

/**
 * Default models per sign-in. One table, meant to be edited: change a row here and every new bot (and every
 * bot that never picked its own models) follows it. A user can override the main-bot and compaction models in
 * settings; nobody has to.
 *
 * - main: the bot you chat with.
 * - worker: delegated work (subagents / herdr workers).
 * - compaction: the ongoing memory compactor (one short call per message and per merge).
 * - importCompaction: the one-off compactor for the first import of old chats. It makes ~9 calls per imported
 *   message, so it is the cheapest model that still writes a usable 512-byte summary line.
 *
 * Prices are USD per million tokens, copied from pi-ai 1.0.2's model list (models.generated.js), used only for
 * the import estimate. Subscription logins (Claude, ChatGPT, Copilot) are not billed per token; for those the
 * estimate shows the API-equivalent value and a share of the plan's weekly allowance (see `weeklyUsd`).
 */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface Defaults {
  label: string;
  /** pi provider id the models below run on. */
  provider: string;
  main: ModelChoice;
  worker: ModelChoice;
  compaction: ModelChoice;
  importCompaction: ModelChoice;
  /** Price of importCompaction, for the estimate. */
  importPrice: Price;
  /** Billing: tokens are paid per token (api), drawn from a plan allowance (plan), per request (requests), or free. */
  billing: 'api' | 'plan' | 'requests' | 'free';
  /**
   * Rough API-equivalent USD a plan allows per week, for the "~Y% of your weekly limit" line. A GUESS: providers
   * do not publish token limits. Undefined means the warning gives tokens and dollars only.
   */
  weeklyUsd?: number;
  note?: string;
}

const m = (provider: string, model: string, thinking: ModelChoice['thinking'] = 'medium'): ModelChoice => ({ provider, model, thinking });
/**
 * The import compactor on Anthropic sign-ins (the owner's rec 23, 27 Oct): the latest Haiku. One constant: flip it
 * back to 'claude-haiku-4-5' if a sign-in lacks 5.5. pi-ai 1.0.2 has no 5.5 price yet, so the estimate uses
 * Haiku 4.5's price (HAIKU) as a stand-in.
 */
export const ANTHROPIC_IMPORT_MODEL = 'claude-haiku-5-5';
const HAIKU: Price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const FREE: Price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const MODEL_DEFAULTS = {
  'claude-pro': {
    label: 'Claude Pro (Claude login)',
    provider: 'anthropic',
    main: m('anthropic', 'claude-sonnet-5-5'),
    worker: m('anthropic', 'claude-sonnet-5-5'),
    compaction: m('anthropic', 'claude-sonnet-5-5', 'low'),
    importCompaction: m('anthropic', ANTHROPIC_IMPORT_MODEL, 'off'),
    importPrice: HAIKU,
    billing: 'plan',
    weeklyUsd: 60,
    note: 'Claude login is billed as extra usage outside Claude apps. Pro limits are tight: main bot on Sonnet.',
  },
  'claude-max': {
    label: 'Claude Max (Claude login)',
    provider: 'anthropic',
    main: m('anthropic', 'claude-opus-5-5'),
    worker: m('anthropic', 'claude-sonnet-5-5'),
    compaction: m('anthropic', 'claude-sonnet-5-5', 'low'),
    importCompaction: m('anthropic', ANTHROPIC_IMPORT_MODEL, 'off'),
    importPrice: HAIKU,
    billing: 'plan',
    weeklyUsd: 600,
    note: 'weeklyUsd assumes Max 20x; Max 5x is about a quarter of it.',
  },
  'anthropic-api': {
    label: 'Anthropic API key',
    provider: 'anthropic',
    main: m('anthropic', 'claude-sonnet-5-5'),
    worker: m('anthropic', 'claude-sonnet-5-5'),
    compaction: m('anthropic', 'claude-sonnet-5-5', 'low'),
    importCompaction: m('anthropic', ANTHROPIC_IMPORT_MODEL, 'off'),
    importPrice: HAIKU,
    billing: 'api',
  },
  chatgpt: {
    label: 'ChatGPT Plus/Pro (Codex login)',
    provider: 'openai-codex',
    main: m('openai-codex', 'gpt-6-sol'),
    worker: m('openai-codex', 'gpt-6-sol'),
    compaction: m('openai-codex', 'gpt-5.6-terra', 'low'),
    importCompaction: m('openai-codex', 'gpt-6-luna', 'low'),
    importPrice: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    billing: 'plan',
    weeklyUsd: 60,
    note: 'weeklyUsd assumes Plus.',
  },
  'openai-api': {
    label: 'OpenAI API key',
    provider: 'openai',
    main: m('openai', 'gpt-6-sol'),
    worker: m('openai', 'gpt-6-sol'),
    compaction: m('openai', 'gpt-5.6-terra', 'low'),
    importCompaction: m('openai', 'gpt-6-luna', 'low'),
    importPrice: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    billing: 'api',
  },
  copilot: {
    label: 'GitHub Copilot',
    provider: 'github-copilot',
    main: m('github-copilot', 'claude-sonnet-5.5'),
    worker: m('github-copilot', 'claude-sonnet-5.5'),
    // Copilot bills premium requests, not tokens: compaction makes thousands of calls, so it uses a model
    // included in the plan at no premium-request cost.
    compaction: m('github-copilot', 'gpt-5-mini', 'low'),
    importCompaction: m('github-copilot', 'gpt-5-mini', 'low'),
    importPrice: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
    billing: 'requests',
    note: 'gpt-5-mini is a 0x (included) model on paid Copilot plans; check before changing it.',
  },
  openrouter: {
    label: 'OpenRouter',
    provider: 'openrouter',
    main: m('openrouter', 'anthropic/claude-sonnet-5.5'),
    worker: m('openrouter', 'anthropic/claude-sonnet-5.5'),
    compaction: m('openrouter', 'anthropic/claude-haiku-4.5', 'low'),
    importCompaction: m('openrouter', 'google/gemini-3.8-flash', 'off'),
    importPrice: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
    billing: 'api',
  },
  google: {
    label: 'Google Gemini API key',
    provider: 'google',
    main: m('google', 'gemini-3.1-pro-preview'),
    worker: m('google', 'gemini-3.8-flash'),
    compaction: m('google', 'gemini-3.8-flash', 'low'),
    importCompaction: m('google', 'gemini-3.1-flash-lite', 'off'),
    importPrice: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
    billing: 'api',
  },
  'openrouter-free': {
    label: 'Free (OpenRouter free models)',
    provider: 'openrouter',
    main: m('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free'),
    worker: m('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free'),
    compaction: m('openrouter', 'qwen/qwen3.8-27b:free', 'low'),
    importCompaction: m('openrouter', 'qwen/qwen3.8-27b:free', 'off'),
    importPrice: FREE,
    billing: 'free',
    note: 'Free models are rate limited (tens of requests a minute, a daily cap): an import runs for days, pausing at each limit.',
  },
  'opencode-free': {
    label: 'Free (OpenCode Zen free models)',
    provider: 'opencode',
    main: m('opencode', 'nemotron-3-ultra-free'),
    worker: m('opencode', 'nemotron-3-ultra-free'),
    compaction: m('opencode', 'nemotron-3.5-lightning-free', 'low'),
    importCompaction: m('opencode', 'nemotron-3.5-lightning-free', 'off'),
    importPrice: FREE,
    billing: 'free',
    note: 'Free models change often; re-check the ids before each release.',
  },
} satisfies Record<string, Defaults>;

export type Subscription = keyof typeof MODEL_DEFAULTS;
export const SUBSCRIPTIONS = Object.keys(MODEL_DEFAULTS) as Subscription[];

/** The first sign-in, in this order, decides the defaults: the most capable plan wins. */
const PREFERENCE: Subscription[] = [
  'claude-max',
  'claude-pro',
  'chatgpt',
  'anthropic-api',
  'openai-api',
  'copilot',
  'openrouter',
  'google',
  'openrouter-free',
  'opencode-free',
];
export function pickSubscription(available: readonly Subscription[]): Subscription | undefined {
  return PREFERENCE.find(s => available.includes(s));
}

/** Per-profile overrides in config.json. Missing keys follow the table, so a later table change reaches them. */
export interface ModelOverrides {
  subscription?: Subscription;
  main?: ModelChoice;
  compactor?: ModelChoice;
  importCompactor?: ModelChoice;
}
export function resolveModels(subscription: Subscription, overrides: ModelOverrides = {}) {
  const row: Defaults = MODEL_DEFAULTS[overrides.subscription ?? subscription];
  return {
    main: overrides.main ?? row.main,
    worker: row.worker,
    compaction: overrides.compactor ?? row.compaction,
    importCompaction: overrides.importCompactor ?? row.importCompaction,
    // A user-picked import model has no price in this table; the estimate then says so.
    importPrice: overrides.importCompactor ? undefined : row.importPrice,
    row,
  };
}

const isChoice = (v: unknown): v is ModelChoice =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ModelChoice).provider === 'string' &&
  typeof (v as ModelChoice).model === 'string' &&
  typeof (v as ModelChoice).thinking === 'string';
/**
 * The import compactor for a profile: its own `importCompactor` in config.json if set, else the table's import model
 * for the profile's `subscription`, else for the first row on the same provider as its ongoing compactor, else the
 * ongoing compactor itself.
 */
export function importModelFor(config: { compactor: ModelChoice; importCompactor?: unknown; subscription?: unknown }): ModelChoice {
  if (isChoice(config.importCompactor)) return config.importCompactor;
  const named = typeof config.subscription === 'string' && Object.hasOwn(MODEL_DEFAULTS, config.subscription);
  const row: Defaults | undefined = named
    ? MODEL_DEFAULTS[config.subscription as Subscription]
    : Object.values(MODEL_DEFAULTS).find((r: Defaults) => r.provider === config.compactor.provider);
  return row?.importCompaction ?? config.compactor;
}
