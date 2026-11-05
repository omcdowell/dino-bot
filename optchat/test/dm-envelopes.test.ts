// Shared bot-dm envelope fixture. test/fixtures/dm-envelopes.jsonl is a byte-identical copy of
// ~/code/paseo-bots/test/fixtures/dm/envelopes.jsonl (the source; bot-dm writes envelopes with
// formatEnvelope there). If an envelope case changes, change it there and copy it here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, tag } from '../src/memory.ts';
import { exportBrowser } from '../src/browser.ts';

type Case = { why: string; text: string; dm: { from: string } | null };
/**
 * Where OptChat parts from bot-dm's parser on purpose: bot-dm rejects a kind it does not know, but memory files any
 * well-formed envelope as dm:<from> whatever its kind, so a kind added later can never be taken for the user's words.
 */
const lenient = (c: Case) => (c.dm ? c.dm.from : c.why === 'unknown kind' ? 'flint' : undefined);
const cases: Case[] = readFileSync(join(import.meta.dirname, 'fixtures', 'dm-envelopes.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line))
  .filter(c => !c.comment);

test('memory tags exactly the fixture DMs as dm:<from>', () => {
  for (const c of cases) {
    const from = lenient(c);
    assert.equal(tag({ kind: 'user', text: c.text }), from ? `dm:${from}` : 'user', c.why);
    assert.equal(tag({ kind: 'talk', text: c.text }), 'talk', c.why);
  }
});

test('the memory browser labels exactly the fixture DMs as "DM from <from>"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-envelopes-'));
  const memory = new Memory(
    dir,
    async input => input.source.slice(0, 100),
    () => {},
  );
  try {
    const html = readFileSync(exportBrowser(memory, 'test'), 'utf8');
    const [source] = html.match(/function who\(e\) \{[\s\S]*?\n\}/) ?? [];
    assert.ok(source);
    const who = new Function(`${source}; return who;`)() as (e: { kind: string; text: string }) => string[];
    for (const c of cases) {
      const label = who({ kind: 'user', text: c.text })[0];
      const from = lenient(c);
      if (from) assert.equal(label, `DM from ${from}`, c.why);
      else assert.doesNotMatch(label, /^DM from/, c.why);
    }
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a kind=resume nudge from the rate-limit watchdog is filed as dm:worker:ratelimit-watchdog, not as the user', () => {
  const resume = cases.find(c => c.dm && (c.dm as { kind?: string }).kind === 'resume');
  assert.ok(resume, 'the fixture has a kind=resume case');
  assert.equal(tag({ kind: 'user', text: resume.text }), 'dm:worker:ratelimit-watchdog');
  assert.ok(
    cases.some(c => c.why === 'unknown kind'),
    'the fixture still has its unknown-kind case',
  );
});
