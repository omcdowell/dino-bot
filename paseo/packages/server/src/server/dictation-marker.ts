/**
 * Starts a dictated message with a short marker, so the model allows for mis-transcribed words.
 * It sits on the message itself, so anything that later reads the message (an OptChat compactor,
 * say) also knows names in it may be misheard. Nothing is added when the message was typed.
 */
export const DICTATION_MARKER = "[dictated] ";

export function markDictated(text: string, dictated: boolean | undefined): string {
  if (dictated !== true || text.trim().length === 0 || text.startsWith(DICTATION_MARKER))
    return text;
  return `${DICTATION_MARKER}${text}`;
}
