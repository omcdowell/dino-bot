import { readFileSync } from 'node:fs';

/**
 * The host's section for a bot (the Paseo bots plugin's "DinoBot bot" rules: bot-dm, workers, group chats, house
 * rules), from the file named by OPTCHAT_BOT_PROMPT. Read on every turn, so the plugin can update it without a
 * restart. Empty when the variable is unset or the file is missing: plain OptChat (no bots plugin) has no section.
 */
export function botSection(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.OPTCHAT_BOT_PROMPT?.trim();
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}
