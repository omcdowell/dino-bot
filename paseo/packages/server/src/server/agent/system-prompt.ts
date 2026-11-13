import { stripRetiredVoiceModeNote } from "../voice-config.js";

/**
 * Joins the non-empty parts of an agent's system prompt. A retired "voice mode is now off" block, which
 * older daemons saved into agent records, is dropped here, so existing agents lose it without a migration.
 */
export function composeSystemPromptParts(
  ...parts: Array<string | null | undefined>
): string | undefined {
  const prompt = parts
    .map((part) => (part == null ? part : stripRetiredVoiceModeNote(part).trim()))
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");

  return prompt.length > 0 ? prompt : undefined;
}
