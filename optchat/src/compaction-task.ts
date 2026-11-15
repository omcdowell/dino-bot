// A compaction's task text (the one user message after the view), on its own so the bots plugin's Claude Code engine
// builds the same task without loading pi's modules. compactor.ts re-exports it.
import { end, name, NODE, start, type Compression } from './memory.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';

export const SCALE =
  'user: Plan the Lisbon trip for 14-18 May: four adults, one in a wheelchair, 2400 EUR budget, no flights before 09:00. talk: Suggested Baixa; skip tram 28 (not step-free). tool: searched TAP, easyJet fares; echo: TAP TP1205 at 08:40 (too early), easyJet U27652 at 11:15 is 162 EUR each. user: "Book easyJet; step-free rooms matter more than a view." work: [4c1e9a20] Casa do Rio has two step-free rooms at 138 EUR/night, free cancellation to 10 May, held to 2 May. talk: Asked about a Sintra day trip, unanswered.';
/** The task after a compaction's view (UniiChat §4), with ids and <input>. The ruler is still the sample line. */
export function task(input: Compression) {
  const part = input.part,
    size = `of at most ${NODE} bytes (about 70 words), the length of this ruler, a made-up line whose words never belong in yours:\n${SCALE}`,
    historical = input.historical ? `\n${IMPORT_GUIDANCE}` : '';
  if (!input.merge)
    return `Compaction: compress ${part ? `message ${start(part)}` : 'the message'} into one line ${size}\n<input>\n${input.source}\n</input>${historical}`;
  const halves = part ? [0, 1].map(k => ({ l: part.l - 1, i: 2 * part.i + k })) : undefined;
  const [a, b] = halves ? halves.map(name) : ['a', 'b'];
  const lines = input.source.split('\n');
  const inputLines = halves && lines.length === 2 ? lines.map((line, k) => `${name(halves[k])}|${line}`).join('\n') : input.source;
  const detail = part
    ? `\n<chat> may hold their messages, ${start(part)} to ${end(part) - 1}, in more detail: take details of them from there too.`
    : '';
  return `Compaction: merge lines ${a} and ${b}, adjacent, into one line ${size}${detail}\n<input>\n${inputLines}\n</input>${historical}`;
}
