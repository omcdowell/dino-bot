import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { appendJson, bytes, end, localDay, Memory, name, start, type Compression } from '../src/memory.ts';
import { EXTRACT_BYTES, isRoomEntry, MemoryReader } from '../src/room/reader.ts';

/** Every file under `dir`, with its hash, so a test can show nothing was written. */
function snapshot(dir: string) {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        files[relative(dir, path) + '/'] = String(statSync(path).mtimeMs);
        walk(path);
      } else files[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex') + ':' + statSync(path).mtimeMs;
    }
  };
  walk(dir);
  return files;
}

const ROOM_TEXT = (n: number) =>
  `[room alarm-clock block 01M${n} msgs 01Ma-01Mb]\nroom:user: @wallace secret room plan ${n}\nroom:wallace: noted`;

/** A small synthetic profile: 40 messages, every seventh a room block, summarised by a fake compactor, view budget 6000. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-reader-'));
  const compress = async (input: Compression) => (input.merge ? 'merged: ' : 'line: ') + input.source.replace(/\s+/g, ' ').slice(0, 150);
  const memory = new Memory(dir, compress, () => {}, 6000);
  for (let i = 0; i < 40; i++) {
    if (i % 7 === 3) memory.append('user', ROOM_TEXT(i));
    else memory.append(i % 2 ? 'talk' : 'user', `Message ${i}: launch date detail ${'filler words '.repeat(i % 5 ? 3 : 50)}`);
  }
  await memory.settle(AbortSignal.timeout(10_000), true);
  await memory.close();
  writeFileSync(join(dir, 'AGENTS.md'), '# wallace\n');
  return { dir, memory };
}

test('the reader shows the same view, zooms, searches and dates as Memory for non-room ids, and writes nothing', async () => {
  const { dir, memory } = await fixture();
  try {
    const before = snapshot(dir);
    const reader = new MemoryReader(dir).refresh();
    assert.deepEqual(reader.view, memory.view);
    assert.ok(memory.tree.size > memory.root.length, 'the fixture has merged lines');
    const room = (i: number) => isRoomEntry(memory.root[i]);
    assert.equal(memory.root.filter(e => isRoomEntry(e)).length, 6);
    for (let id = 0; id < memory.root.length; id++) {
      if (room(id)) assert.throws(() => reader.zoom(id, 1), /room talk/);
      else assert.equal(reader.zoom(id, 1), memory.zoom(id, 1));
      assert.equal(reader.date(id), memory.date(id));
    }
    let compared = 0;
    for (const node of memory.tree.values()) {
      if (node.l === 0) continue;
      const id = start(node),
        n = 2 ** node.l;
      const leafRoom = node.l === 1 && [0, 1].some(o => room(id + o));
      if (leafRoom) assert.doesNotMatch(reader.zoom(id, n), /\[room /);
      else {
        assert.equal(reader.zoom(id, n), memory.zoom(id, n));
        compared++;
      }
    }
    assert.ok(compared > 5);
    assert.equal(reader.search('launch detail'), memory.search('launch detail'));
    assert.equal(reader.search('message 1', 5), memory.search('message 1', 5));
    assert.match(memory.search('secret room plan'), /\+0\|room:alarm-clock /);
    assert.equal(reader.search('secret room plan'), 'No messages match "secret room plan".');
    assert.throws(() => reader.zoom(3, 4), /No line/);
    assert.throws(() => reader.date(400), /No message/);
    reader.extract();
    reader.extract(500);
    assert.deepEqual(snapshot(dir), before, 'no file under the profile changed');
    assert.equal(existsSync(join(dir, 'lock.sock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extract fits maxBytes, keeps the newest lines finest with main view heads, and leaves out room leaves', async () => {
  const { dir, memory } = await fixture();
  try {
    const reader = new MemoryReader(dir);
    const full = reader.extract();
    assert.ok(bytes(full) <= EXTRACT_BYTES);
    assert.match(full, /^<main-memory>\n[\s\S]*\n<\/main-memory>$/);
    const lines = full.split('\n').slice(1, -1);
    // At 32 KB nothing needs merging: the extract is the main view, minus room leaves.
    const expected = memory.view.filter(p => !(p.l === 0 && isRoomEntry(memory.root[p.i])));
    assert.deepEqual(
      lines.map(l => l.split('|')[0]),
      expected.map(p => name(p)),
    );
    assert.doesNotMatch(full, /^\d+\+1\|(?:user|room:alarm-clock): \[room /m);
    for (const max of [3000, 1200, 600, 300, 120, 40]) {
      const small = reader.extract(max);
      assert.ok(bytes(small) <= max, `${bytes(small)} > ${max}`);
      assert.doesNotMatch(small, /^\d+\+1\|(?:user|room:alarm-clock): \[room /m);
      const heads = small
        .split('\n')
        .slice(1, -1)
        .filter(l => /^\d+\+\d+\|/.test(l));
      if (!heads.length) continue;
      // Heads are main-view names; the newest line is never coarser than older ones.
      const parts = heads.map(h => {
        const [id, n] = h.split('|')[0].split('+').map(Number);
        assert.ok(memory.node({ l: Math.log2(n), i: id / n }) || n === 1, h);
        return { id, n };
      });
      assert.ok(parts.at(-1)!.n <= parts[0].n);
      if (max === 3000) assert.ok(parts[0].n > 1 && parts.at(-1)!.n === 1, 'merged further, newest finest');
      assert.equal(parts.at(-1)!.id + parts.at(-1)!.n, memory.root.length, 'the newest message is kept');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extract drops the oldest lines when merges are not built, and stays within maxBytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-reader-'));
  try {
    mkdirSync(join(dir, 'main'));
    const file = join(dir, 'main', `${localDay()}.jsonl`);
    for (let i = 0; i < 30; i++) appendJson(file, { i, kind: 'user', text: `unbuilt ${i}`, date: new Date().toISOString() });
    const reader = new MemoryReader(dir);
    const out = reader.extract(300);
    assert.ok(bytes(out) <= 300);
    assert.match(out, /older lines left out/);
    assert.match(out, /29\+1\|\(not summarized yet: zoom it\)/);
    assert.deepEqual(readdirSync(dir), ['main'], 'no view.json, tree or lock was created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the reader reloads when the bot appends, and ignores a summary written past the log it read', async () => {
  const { dir, memory } = await fixture();
  try {
    const reader = new MemoryReader(dir).refresh();
    const count = reader.root.length;
    const file = readdirSync(join(dir, 'main')).find(f => f.endsWith('.jsonl'))!;
    appendJson(join(dir, 'main', file), { i: count, kind: 'user', text: 'a brand new launch note', date: new Date().toISOString() });
    appendJson(join(dir, 'tree', `${localDay()}.jsonl`), { l: 0, i: count + 5, text: 'from the future' });
    assert.match(reader.search('brand new'), new RegExp(`^${count}\\+0\\|user`));
    assert.equal(reader.root.length, count + 1);
    assert.equal(end(reader.view.at(-1)!), count + 1);
    assert.match(reader.zoom(count, 1), /brand new launch note/);
    assert.equal(memory.root.length, count);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
