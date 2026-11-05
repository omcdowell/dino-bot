import type { Context } from '@earendil-works/pi-ai';
import { textContent } from '../src/transcript.ts';

/** A compaction's last message ends with its task, which starts "Compaction:". */
export const isCompaction = (context: Context) => {
  const content = context.messages.at(-1)?.content;
  const last = Array.isArray(content) ? content.at(-1) : content;
  return textContent(typeof last === 'string' || last === undefined ? last : [last]).startsWith('Compaction:');
};
