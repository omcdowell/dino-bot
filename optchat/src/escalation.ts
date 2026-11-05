import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Escalation } from './memory.ts';
import { escalateTo } from './user.ts';

const exec = promisify(execFile);
/** Who hears about nodes the provider refused: the host's escalation bot (BOTS_ESCALATE_TO), or nobody. */
export const ESCALATE_TO = () => escalateTo();
/** Messages listed one by one; a bigger merge is summed up. */
const LISTED = 16;

/**
 * The escalation DM for a node built from a fallback line. It holds only facts about the node (profile, id, the
 * messages it covers with their kinds, sizes and dates, and the failure's reason), never any of their text: quoting the
 * refused text would put it into the recipient's memory, where it could be refused again.
 */
export function escalationText(profile: string, e: Escalation) {
  const first = e.messages[0],
    last = e.messages.at(-1)!,
    ids = first.id === last.id ? `${first.id}` : `${first.id}-${last.id}`;
  const listed =
    e.messages.length <= LISTED
      ? e.messages.map(m => `${m.id} ${m.kind} ${m.bytes} B ${m.date}`)
      : [
          `${e.messages.length} messages, ${e.messages.reduce((n, m) => n + m.bytes, 0)} B, ${first.date} to ${last.date}`,
          `kinds: ${Object.entries(
            e.messages.reduce<Record<string, number>>((count, m) => ({ ...count, [m.kind]: (count[m.kind] ?? 0) + 1 }), {}),
          )
            .map(([kind, n]) => `${kind} ${n}`)
            .join(', ')}`,
        ];
  return [
    `OptChat compactor: line ${e.node} of profile ${profile} was not summarised (permanent failure: ${e.reason}).`,
    `It holds a fallback line marked "not summarised"; lines above it are not merged until it is replaced. Messages ${ids}:`,
    ...listed,
    `Replace it with: npm run cli -- resummarise ${profile} ${e.node} --text "<line>" (in ~/code/pi-optchat).`,
  ].join('\n');
}

export type Run = (file: string, args: string[]) => Promise<unknown>;
const run: Run = (file, args) => exec(file, args, { timeout: 30_000 });

/**
 * Sends the escalation with bot-dm, which stamps the running bot (PASEO_AGENT_ID) as the sender. With no escalation
 * bot on the host it sends nothing (the fallback line stays marked "not summarised" in the error log).
 */
export function escalator(profile: string, send: Run = run, to: () => string | null = ESCALATE_TO) {
  return async (e: Escalation) => {
    const recipient = to();
    if (!recipient) return;
    await send('bot-dm', [
      recipient,
      '--kind',
      'escalate',
      '--subject',
      `OptChat ${profile}: line ${e.node} not summarised`,
      '--text',
      escalationText(profile, e),
    ]);
  };
}
