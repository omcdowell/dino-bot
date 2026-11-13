const VOICE_PROMPT_BLOCK_START = "<paseo_voice_mode>";
const VOICE_PROMPT_BLOCK_END = "</paseo_voice_mode>";

const VOICE_AGENT_SYSTEM_INSTRUCTION = [
  "Paseo voice mode is now on.",
  "You are the Paseo voice assistant.",
  "The user cannot see your chat messages or tool calls.",
  "Always use the speak tool for all user-facing communication.",
  "Before calling any non-speak tool, first call speak with a short acknowledgement of what you heard and what you will do next.",
  "For long-running work, use speak to provide progress updates before and during execution.",
  "Treat the user input as transcribed speech.",
  "If the user intent is clear, proceed without extra confirmation.",
  "If the transcription seems incomplete, cut off, ambiguous, or may contain a non-obvious mistake or misspelling, ask a clarifying question via speak before taking action.",
  "Use concise plain language suitable for speech output.",
].join(" ");

// Voice mode off used to leave a "<paseo_voice_mode>Paseo voice mode is now off. ..." block in the
// agent's system prompt. Off now means no block at all; records saved with the old block lose it when
// the prompt is rendered (stripRetiredVoiceModeNote, via composeSystemPromptParts).
const RETIRED_VOICE_OFF_NOTE =
  /\s*<paseo_voice_mode>\s*Paseo voice mode is now off\.[\s\S]*?<\/paseo_voice_mode>/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeVoicePromptBlockRegex(): RegExp {
  return new RegExp(
    `${escapeRegExp(VOICE_PROMPT_BLOCK_START)}[\\s\\S]*?${escapeRegExp(VOICE_PROMPT_BLOCK_END)}`,
    "g",
  );
}

export function stripVoiceModeSystemPrompt(existing?: string): string | undefined {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = trimmed.replace(makeVoicePromptBlockRegex(), "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

/** Removes the retired voice-off block and the space before it; the rest (an active voice block too) is kept. */
export function stripRetiredVoiceModeNote(prompt: string): string {
  if (!prompt.includes(VOICE_PROMPT_BLOCK_START)) return prompt;
  return prompt.replace(RETIRED_VOICE_OFF_NOTE, "").trim();
}

/**
 * The agent's system prompt with voice mode on or off. Off returns the base prompt alone ("" when there
 * is none, so a reload override still replaces the voice-on prompt).
 */
export function buildVoiceModeSystemPrompt(existing: string | undefined, enabled: boolean): string {
  const basePrompt = stripVoiceModeSystemPrompt(existing);
  if (!enabled) return basePrompt ?? "";
  const voiceBlock = [
    VOICE_PROMPT_BLOCK_START,
    VOICE_AGENT_SYSTEM_INSTRUCTION,
    VOICE_PROMPT_BLOCK_END,
  ].join("\n");

  return [basePrompt, voiceBlock]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n\n");
}

export function wrapSpokenInput(text: string): string {
  return `<spoken-input>\n${text}\n</spoken-input>\n<instruction>This message was spoken by the user. Respond using the speak tool only, not normal messages, because the user may not be looking at the chat.</instruction>`;
}

export function buildVoiceAgentMcpServerConfig(params: {
  command: string;
  baseArgs: string[];
  socketPath: string;
  env?: Record<string, string>;
}): {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  return {
    type: "stdio",
    command: params.command,
    args: [...params.baseArgs, "--socket", params.socketPath],
    ...(params.env ? { env: params.env } : {}),
  };
}
