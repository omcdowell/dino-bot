import { NODE } from './memory.ts';

/** Per-profile choices where OptChat departs from Victor's recipe. Each default is the recipe's behaviour unless noted. */
export const SETTINGS = {
  previousExchange: {
    kind: 'toggle',
    label: 'Previous exchange',
    default: true,
    description:
      "Send your last request and its answer in full with the next turn, so a follow-up reads the exact wording. Off: memory view only, as in Victor's recipe. On by default: a study found it costs little and saves zooms.",
    applies: 'Applies from the next turn.',
  },
  previousExchangeKB: {
    kind: 'number',
    label: 'Previous exchange limit',
    default: 16,
    min: 1,
    unit: 'KB',
    description: 'A larger last exchange, usually a big paste, is left out and the model zooms into memory instead.',
    applies: 'Applies from the next turn.',
  },
  toolDigest: {
    kind: 'toggle',
    label: 'Tool digest',
    default: false,
    description:
      "Log one digest of each turn's tool steps (calls, results clipped to 400 characters, commentary to 300) instead of every tool call and result as its own message. Fewer compactor calls, but what the clips cut never reaches memory. Off (default): every call and result is logged, results clipped to 30,000 characters (head and tail), as in Victor's recipe.",
    applies: 'Applies from the next turn.',
  },
  summaryAcceptBytes: {
    kind: 'number',
    label: 'Summary size tolerance',
    default: NODE * 1.25,
    min: NODE,
    unit: 'bytes',
    description: `The compactor is always asked for ${NODE}-byte lines; a longer line up to this size is kept instead of retried. ${NODE}: strict, as in Victor's recipe. The default saves retries for a little more view space.`,
    applies: 'Applies to the next summary.',
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = { -readonly [K in SettingKey]: (typeof SETTINGS)[K]['default'] extends boolean ? boolean : number };
export type NumberKey = { [K in SettingKey]: Settings[K] extends number ? K : never }[SettingKey];
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isNumberKey = (key: SettingKey): key is NumberKey => SETTINGS[key].kind === 'number';

/** Why a value can't be used, or undefined if it can. Numbers are whole and at least their minimum. */
export function invalid(key: SettingKey, value: unknown) {
  if (isNumberKey(key)) {
    const { label, min } = SETTINGS[key];
    return Number.isSafeInteger(value) && Number(value) >= min ? undefined : `${label} must be a whole number of ${min} or more.`;
  }
  return typeof value === 'boolean' ? undefined : `${SETTINGS[key].label} must be true or false.`;
}

/** Missing keys take their defaults, so config files written before a setting existed keep working. */
export function readSettings(value: Record<string, unknown>): Settings {
  return Object.fromEntries(
    SETTING_KEYS.map(key => {
      const raw = Object.hasOwn(value, key) ? value[key] : SETTINGS[key].default,
        problem = invalid(key, raw);
      if (problem) throw new Error(problem);
      return [key, raw];
    }),
  ) as Settings;
}
export const DEFAULT_SETTINGS = readSettings({});
