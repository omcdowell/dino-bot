// Explicit opt-in live check of the bot-DM prompt patch: forces merges with the real compactor on a copy of a
// throwaway profile and prints every line that covers a [dm …] message.
//   npx tsx test/live-dm.ts <profile-dir> [budget-bytes]
// The profile is copied to a temp directory first; the original is never written.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor, type ModelChoice } from '../src/compactor.ts';
import { Memory, start, end } from '../src/memory.ts';

const [source, budgetArg] = process.argv.slice(2);
if (!source) throw new Error('usage: tsx test/live-dm.ts <profile-dir> [budget-bytes]');
const budget = Number(budgetArg ?? 2500);
const copy = mkdtempSync(join(tmpdir(), 'optchat-dm-'));
for (const sub of ['main', 'tree']) cpSync(join(source, sub), join(copy, sub), { recursive: true });
const config = JSON.parse(readFileSync(join(source, 'config.json'), 'utf8')) as { compactor: ModelChoice };
const registry = new ModelRegistry(await ModelRuntime.create());
let calls = 0;
const compress = createCompressor(
  registry,
  () => config.compactor,
  () => calls++,
);
const memory = new Memory(copy, compress, console.error, budget);
try {
  await memory.settle(AbortSignal.timeout(600_000), true);
  const dms = memory.root.filter(e => e.kind === 'user' && e.text.startsWith('[dm ')).map(e => e.i);
  console.log(JSON.stringify({ compactorCalls: calls, entries: memory.root.length, budget, size: memory.size, dmEntries: dms }));
  for (const part of memory.view) {
    const covered = dms.filter(i => i >= start(part) && i < end(part));
    if (covered.length)
      console.log(
        JSON.stringify({ line: `${start(part)}+${end(part) - start(part)}`, l: part.l, dms: covered, text: memory.node(part)?.text }),
      );
  }
} finally {
  await memory.close();
  rmSync(copy, { recursive: true, force: true });
}
