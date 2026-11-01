import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover, readDiscovered } from '../src/import/discover.ts';
import { estimate, warning, nodesNeeded, CALIBRATION } from '../src/import/estimate.ts';
import { backgroundState, finishBackground, runBackground, startBackground, discardBackground, backgroundDir } from '../src/import/auto.ts';
import { MODEL_DEFAULTS, SUBSCRIPTIONS, importModelFor, pickSubscription, resolveModels } from '../src/model-defaults.ts';
import { Memory, type Compressor } from '../src/memory.ts';
import { memoryDirectory } from '../src/import/job.ts';
import { CompactorError } from '../src/provider-error.ts';
import { fakeHome } from './fixtures/fake-home.ts';

// TMPDIR points under ~/scratch when run on the host (/tmp is RAM there). The tests also pass with
// the home under /tmp or macOS /var/folders (a bot folder is a bot folder first).
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-auto-import-'));

test('discovery finds every source, groups by project, unticks throwaway folders', async () => {
  const home = temp();
  try {
    fakeHome(home);
    const found = await discover(home);
    const counts = Object.fromEntries(found.sources.map(s => [s.source, s.conversations]));
    assert.deepEqual(counts, { pi: 4, claude: 1, 'claude-memory': 1, codex: 1, cursor: 1, gemini: 1 });
    const byName = new Map(found.projects.map(p => [p.project, p]));
    assert.equal(byName.get('/tmp/x')?.ticked, false);
    assert.equal(byName.get(join(home, 'bots/flint'))?.unticked, 'bot');
    assert.equal(byName.get('/home/u/code/app')?.ticked, true);
    assert.deepEqual(byName.get('/home/u/code/api')?.sources, { claude: 1, 'claude-memory': 1, codex: 1 });
    assert.equal(byName.get('/home/u/code/web')?.sources.gemini, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('adapters keep requests and final replies only; a pi fork imports its copied messages once', async () => {
  const home = temp();
  try {
    fakeHome(home);
    const found = await discover(home);
    const read = await readDiscovered(found);
    const texts = read.entries.map(e => `${e.origin?.source}:${e.kind}:${e.text.split('\n').slice(1).join(' ')}`);
    assert.deepEqual(texts.filter(t => t.startsWith('pi:')).sort(), [
      'pi:talk:Login page added at /login.',
      'pi:user:Add a login page',
      'pi:user:Now add logout',
    ]);
    assert.ok(texts.includes('cursor:user:Fix the navbar'));
    assert.ok(texts.includes('cursor:talk:Navbar fixed.'));
    assert.ok(!texts.some(t => t.includes('Looking') || t.includes('Checking') || t.includes('Reading files') || t.includes('partial')));
    assert.ok(texts.includes('gemini:talk:Vite builds it.'));
    assert.ok(texts.includes('codex:talk:Migration 004 written.'));
    assert.ok(texts.includes('claude:talk:An N+1 query in /orders.'));
    assert.ok(!texts.some(t => t.includes('smoke test') || t.includes('bot chat')), 'throwaway and bot projects unticked');
    assert.equal(read.perProject.get('/home/u/code/app')?.messages, 3);
    // Unticking a project leaves it out.
    const fewer = await readDiscovered(found, ['/home/u/code/api']);
    assert.ok(fewer.entries.every(e => e.origin?.project === '/home/u/code/api'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('estimate follows the calibration import and the warning states tokens, share and time', () => {
  // FC's import: $217.32 over 20,855 calls; any log of the same node count costs the same per call.
  const fcSizes = Array.from({ length: CALIBRATION.messages }, (_, i) => (i < 1066 ? 3000 : 300));
  const sonnet = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
  const fc = estimate(fcSizes, sonnet);
  assert.equal(fc.calls, Math.round(nodesNeeded(fcSizes) * CALIBRATION.callsPerNode));
  assert.ok(Math.abs(fc.usd!.mid / fc.calls - 217.32 / 20855) < 0.0002, `per call ${fc.usd!.mid / fc.calls}`);
  assert.ok(Math.abs(fc.hours / fc.calls - 11.2 / 20855) < 1e-5);
  // Short messages need no leaf calls, so they cost far less than long ones.
  assert.ok(estimate(Array(1000).fill(100), sonnet).calls < estimate(Array(1000).fill(2000), sonnet).calls / 2);
  const row = MODEL_DEFAULTS['claude-pro'];
  const e = estimate(Array(1000).fill(1000), row.importPrice, row.weeklyUsd);
  const text = warning(e, row);
  assert.match(text, /will use a lot of your subscription/);
  assert.match(text, /1,000 messages → about \d+\.\d M tokens with claude-haiku-5-5/);
  assert.match(text, /roughly \d+% of a weekly Claude Pro/);
  assert.match(text, /background/);
  assert.match(warning(e, MODEL_DEFAULTS['anthropic-api']), /on your API bill/);
  assert.match(
    warning(estimate(Array(10).fill(1000), MODEL_DEFAULTS['openrouter-free'].importPrice), MODEL_DEFAULTS['openrouter-free']),
    /free/,
  );
});

test('defaults table: every row complete, import model never pricier than compaction, overrides win', () => {
  for (const s of SUBSCRIPTIONS) {
    const r = MODEL_DEFAULTS[s];
    for (const k of ['main', 'worker', 'compaction', 'importCompaction'] as const) assert.equal(r[k].provider, r.provider, `${s}.${k}`);
  }
  assert.equal(pickSubscription(['openrouter', 'claude-pro']), 'claude-pro');
  assert.equal(resolveModels('claude-max').importCompaction.model, 'claude-haiku-5-5');
  const own = { provider: 'anthropic', model: 'claude-haiku-4-5', thinking: 'off' as const };
  assert.deepEqual(resolveModels('claude-max', { importCompactor: own }).importCompaction, own);
  const compactor = { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' as const };
  assert.equal(importModelFor({ compactor }).model, 'claude-haiku-5-5');
  assert.deepEqual(importModelFor({ compactor, importCompactor: own }), own);
  assert.equal(importModelFor({ compactor, subscription: 'copilot' }).model, 'gpt-5-mini');
  assert.deepEqual(importModelFor({ compactor: { provider: 'nowhere', model: 'x', thinking: 'low' } }).model, 'x');
});

test('background import: stops at a rate limit, resumes, then finishes with messages logged meanwhile', async () => {
  const home = temp(),
    dir = join(home, 'profile');
  try {
    fakeHome(home, 4);
    mkdirSync(dir);
    // The bot already has two live messages.
    const live = new Memory(
      dir,
      async () => 'x',
      () => {},
      undefined,
      0,
    );
    live.append('user', 'live hello');
    live.append('talk', 'live hi');
    await live.close();
    const read = await readDiscovered(await discover(home));
    const state = startBackground(dir, read.entries)!;
    assert.equal(state.base, 2);
    assert.ok(!existsSync(join(dir, 'imports', 'pending.json')), 'the live profile shows no pending import');
    let calls = 0,
      clock = Date.parse('2026-10-26T00:00:00Z');
    const now = () => clock;
    // Fails with 429 on the third call; Retry-After 120 s.
    const limited: Compressor = async input => {
      calls++;
      if (calls === 3) throw new CompactorError('429 rate_limit_error', 429, 120_000);
      return `s:${input.source.length}`;
    };
    const first = await runBackground(dir, limited, new AbortController().signal, undefined, { now });
    assert.equal(first.status, 'rate-limited');
    assert.equal(backgroundState(dir)?.resumeAfter, new Date(clock + 120_000).toISOString());
    const before = calls;
    assert.equal((await runBackground(dir, limited, new AbortController().signal, undefined, { now })).status, 'rate-limited');
    assert.equal(calls, before, 'no calls before resumeAfter');
    // Meanwhile the bot logs another message.
    const again = new Memory(
      dir,
      async () => 'x',
      () => {},
      undefined,
      0,
    );
    again.append('user', 'asked during import');
    await again.close();
    clock += 121_000;
    assert.equal((await runBackground(dir, limited, new AbortController().signal, undefined, { now })).status, 'ready');
    const job = finishBackground(dir);
    assert.ok(!existsSync(backgroundDir(dir)));
    const active = memoryDirectory(dir);
    assert.equal(active, join(dir, job.target));
    const memory = new Memory(
      active,
      async () => 'x',
      () => {},
      undefined,
      0,
    );
    try {
      const texts = memory.root.map(e => e.text);
      assert.equal(memory.root.length, read.entries.length + 3);
      assert.equal(texts.at(-1), 'asked during import', 'messages logged during the import come last');
      assert.ok(texts.includes('live hello'));
      assert.ok(memory.root.every((e, i) => e.i === i));
    } finally {
      await memory.close();
    }
    assert.equal(JSON.parse(readFileSync(join(dir, 'imports', `${job.id}.json`), 'utf8')).liveTail, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('background import: pause keeps finished summaries; discard leaves memory untouched', async () => {
  const home = temp(),
    dir = join(home, 'profile');
  try {
    fakeHome(home, 3);
    mkdirSync(dir);
    const read = await readDiscovered(await discover(home));
    startBackground(dir, read.entries);
    const controller = new AbortController();
    let calls = 0;
    const slow: Compressor = async () => {
      if (++calls === 2) controller.abort();
      return 'summary';
    };
    assert.equal((await runBackground(dir, slow, controller.signal)).status, 'paused');
    assert.equal(backgroundState(dir)?.status, 'paused');
    assert.throws(() => finishBackground(dir), /not built/);
    discardBackground(dir);
    assert.ok(!existsSync(backgroundDir(dir)));
    assert.equal(memoryDirectory(dir), dir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
