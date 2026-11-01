import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, mostDue, start, localDay, type Compression, type Part } from '../src/memory.ts';

const names = (parts: readonly Part[]) => parts.map(p => `${start(p)}+${2 ** p.l}`).join(', ');

/** Victor Taelin's rollback push (UniiChat §3.1), and its list read as a view, oldest first. */
type State = { keep: number; state: number; older: State | null };
const push = (s: number, st: State | null): State =>
  st === null
    ? { keep: 0, state: s, older: null }
    : st.keep === 0
      ? { ...st, keep: 1 }
      : { keep: 0, state: s, older: push(st.state, st.older) };
const pushView = (st: State | null, total: number) => {
  const starts: number[] = [];
  for (let x = st; x; x = x.older) starts.push(x.state);
  starts.reverse();
  return starts.map((s, k) => `${s}+${(k + 1 < starts.length ? starts[k + 1] : total) - s}`).join(', ');
};

test('with the push list length as the budget, the most due merge is exactly the one push makes, t = 0..2000', () => {
  let st: State | null = null;
  const view: Part[] = [];
  for (let t = 0; t <= 2000; t++) {
    st = push(t, st);
    view.push({ l: 0, i: t });
    const expected = pushView(st, t + 1);
    while (view.length > expected.split(', ').length) {
      const best = mostDue(view, t + 1, () => true);
      assert.ok(best >= 0);
      const a = view[best];
      view.splice(best, 2, { l: a.l + 1, i: a.i / 2 });
    }
    assert.equal(names(view), expected, `t=${t}`);
  }
});

test("the spec's example: at T=10 the view 0+4, 4+4, 8+1, 9+1 merges 8-9, not 0-7", () => {
  const view: Part[] = [
    { l: 2, i: 0 },
    { l: 2, i: 1 },
    { l: 0, i: 8 },
    { l: 0, i: 9 },
  ];
  const best = mostDue(view, 10, () => true);
  const a = view[best];
  view.splice(best, 2, { l: a.l + 1, i: a.i / 2 });
  assert.equal(names(view), '0+4, 4+4, 8+2');
  assert.equal(
    mostDue(view.slice(0, 2), 10, () => false),
    -1,
    'a pair whose parent is not built is never merged',
  );
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** An async compactor with uneven delays and sizes, so merges land out of order as they do live. */
function slowCompressor() {
  let n = 0;
  return async (input: Compression) => {
    await sleep(1 + (n++ % 7));
    return `${input.merge ? 'M' : 'L'}${n} `.padEnd(200 + (n % 5) * 40, 'x');
  };
}
const refuse = async () => {
  throw new Error('a reopened view must not need the compactor');
};

test('reopening after live use gives the identical view: view.json is loaded, not replayed', async () => {
  // The review's replay check: with a replay, 3 of these 12 reopens showed a different view.
  const dir = mkdtempSync(join(tmpdir(), 'optchat-view-'));
  const live = new Memory(dir, slowCompressor(), () => {}, 12_000, 8, 10);
  const mismatches: number[] = [];
  try {
    for (let t = 0; t < 600; t++) {
      live.append(t % 3 ? 'talk' : 'user', `message ${t} `.padEnd(700, 'y'));
      if (t % 3 === 2) await live.settle(AbortSignal.timeout(5000)); // a turn every three messages
      if (t % 50 === 49) {
        await live.settle(AbortSignal.timeout(10_000), true);
        const reopened = new Memory(dir, refuse, () => {}, 12_000, 8, 10);
        if (reopened.render() !== live.render()) mismatches.push(t);
        await reopened.close();
      }
    }
    assert.deepEqual(mismatches, []);
  } finally {
    await live.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a profile without view.json replays once and saves it; a damaged one is replayed with a warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-view-'));
  const compress = async (input: Compression) => input.source.slice(0, 300);
  let memory = new Memory(dir, compress, () => {}, 3000);
  try {
    for (let i = 0; i < 40; i++) memory.append('user', `Message ${i}: ${'detail '.repeat(100)}`);
    await memory.settle(AbortSignal.timeout(5000), true);
    const live = memory.render();
    await memory.close();
    const file = join(dir, 'view.json');
    assert.ok(existsSync(file));
    rmSync(file);
    memory = new Memory(dir, refuse, () => {}, 3000);
    assert.ok(existsSync(file), 'the replayed view is saved at once');
    assert.ok(memory.view.some(p => p.l > 0) && memory.size <= 3000);
    const replayed = memory.render();
    await memory.close();
    memory = new Memory(dir, refuse, () => {}, 3000);
    assert.equal(memory.render(), replayed, 'the next start loads what the replay saved');
    await memory.close();
    assert.ok(live.length > 0);
    const warnings: string[] = [];
    for (const damaged of ['[[0,0],[0,2]]', '[[6,0]]', '[[1,0' /* torn */, 'not json', '{"l":0}']) {
      writeFileSync(file, damaged);
      memory = new Memory(dir, refuse, text => warnings.push(text), 3000);
      assert.equal(memory.render(), replayed);
      await memory.close();
    }
    assert.equal(warnings.length, 5);
    assert.ok(warnings.every(w => /Rebuilt the view/.test(w)));
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('messages logged after the saved view are appended to it as new lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-view-'));
  const compress = async (input: Compression) => input.source.slice(0, 300);
  let memory = new Memory(dir, compress, () => {}, 3000);
  try {
    for (let i = 0; i < 20; i++) memory.append('user', `Message ${i}: ${'detail '.repeat(100)}`);
    await memory.settle(AbortSignal.timeout(5000), true);
    const before = [...memory.view];
    await memory.close();
    // Written as another tool would: straight to the log, without touching view.json.
    const date = new Date().toISOString();
    appendFileSync(join(dir, 'main', `${localDay()}.jsonl`), JSON.stringify({ i: 20, kind: 'user', text: 'late', date }) + '\n');
    memory = new Memory(dir, compress, () => {}, 3000);
    assert.deepEqual(memory.view, [...before, { l: 0, i: 20 }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8')).length, before.length, 'appending lines does not rewrite it');
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with every ready merge built, a batch completes as soon as the view passes its budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-view-'));
  const compress = async (input: Compression) => input.source.slice(0, 300);
  const memory = new Memory(dir, compress, () => {}, 30_000);
  try {
    let batches = 0;
    for (let i = 0; i < 300; i++) {
      const before = memory.size;
      memory.append('user', `Message ${i}: ${'detail '.repeat(100)}`);
      // Synchronously, before any compaction could run.
      if (memory.size < before) {
        batches++;
        assert.ok(memory.size <= 15_000, `batch at ${i} stopped at ${memory.size} bytes`);
      }
      await memory.settle(AbortSignal.timeout(5000), true);
    }
    assert.ok(batches >= 3, `${batches} batches`);
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('up to 8 messages are summarized at once, each with a view that stops at its first unsummarized line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-pipeline-'));
  const waiting: { input: Compression; release: () => void }[] = [];
  const memory = new Memory(
    dir,
    input =>
      new Promise<string>(resolve => {
        waiting.push({ input, release: () => resolve(`summary of ${input.part ? start(input.part) : '?'}`) });
      }),
    () => {},
  );
  const flush = () => new Promise(resolve => setTimeout(resolve, 5));
  try {
    for (let i = 0; i < 12; i++) memory.append('user', `Message ${i}: ${'detail '.repeat(100)}`);
    await flush();
    assert.deepEqual(
      waiting.map(w => w.input.part!.i),
      [0, 1, 2, 3, 4, 5, 6, 7],
      'eight leaves in flight, not one',
    );
    for (const { input } of waiting) assert.equal(input.context, '<chat>\n\n</chat>', 'message 0 is not built, so no view yet');
    waiting[2].release(); // out of order: 2 lands first, and 8 may start; its view still stops at message 0
    await flush();
    assert.equal(waiting.at(-1)!.input.part!.i, 8);
    assert.equal(waiting.at(-1)!.input.context, '<chat>\n\n</chat>');
    waiting[0].release();
    waiting[1].release();
    await flush();
    const ninth = waiting.find(w => w.input.part!.i === 9)!;
    assert.equal(
      ninth.input.context
        .split('\n')
        .slice(1, -1)
        .map(l => l.split('|')[0])
        .join(','),
      '0+1,1+1,2+1',
      'up to the first unbuilt line, 3',
    );
    for (const w of waiting) w.release();
    while (waiting.length < 12 || !memory.ready) {
      for (const w of waiting) w.release();
      await flush();
    }
    await memory.settle(AbortSignal.timeout(5000));
    assert.equal(memory.pending, 0);
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
