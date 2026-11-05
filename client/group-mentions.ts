/**
 * Mention positions for the thread's @mention highlight, with the same token rules as the router's
 * `parseMentions` (U1, re-exported below): "@" not after a word char, ".", "@", "+" or "-", the name
 * starts with a letter or digit, trailing "-"/"_" are punctuation.
 */
import type { Group } from "../shared/rooms/schema";

/** One "@word" in the text: start index of "@", end index after the word, the word itself. */
export type MentionToken = { start: number; end: number; word: string };

const WORD_CHAR = /[A-Za-z0-9_-]/;
/** Characters that may not come right before "@" (so "email@x.com" is not a mention). */
const BEFORE_BAD = /[A-Za-z0-9_.@+-]/;

/** Every "@word" that is word-bounded on the left. */
export function mentionTokens(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    if (i > 0 && BEFORE_BAD.test(text[i - 1]!)) continue;
    let j = i + 1;
    while (j < text.length && WORD_CHAR.test(text[j]!)) j++;
    // Trailing "-" or "_" is punctuation, not part of the name ("@wallace-" → wallace).
    while (j > i + 1 && /[-_]/.test(text[j - 1]!)) j--;
    if (j > i + 1 && /[A-Za-z0-9]/.test(text[i + 1]!)) out.push({ start: i, end: j, word: text.slice(i + 1, j) });
  }
  return out;
}

/** Lower-case keys a member answers to: its id and the first word of its display name. */
export function memberKeys(group: Group, names: Record<string, string>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const id of group.members) {
    keys.set(id.toLowerCase(), id);
    const first = (names[id] ?? "").trim().split(/\s+/)[0]?.toLowerCase();
    if (first && !keys.has(first)) keys.set(first, id);
  }
  return keys;
}

export const ALL_WORDS = new Set(["all", "everyone"]);

/** What a token refers to: a member id, "all", or null (not a member: ignored). */
export function resolveToken(word: string, keys: Map<string, string>): string | null {
  const w = word.toLowerCase();
  if (ALL_WORDS.has(w)) return "all";
  return keys.get(w) ?? null;
}

/** The router's own parser (U1), so the hint and the highlight agree with where a message goes. */
export { parseMentions, type Mentions } from "../shared/rooms/router";
