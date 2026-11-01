import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, NODE, bytes, type Compression } from '../src/memory.ts';
import { classify, CompactorError } from '../src/provider-error.ts';

const BLOCKED =
  "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs";
const long = (i: number) => `Message ${i}: ${'detail '.repeat(100)}`;
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
    : [];

async function withMemory(
  compress: (input: Compression) => Promise<string>,
  run: (memory: Memory, log: string) => Promise<void>,
  { budget = 128_000, retryMs = 10 } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-blocked-'));
  const log = join(dir, 'compactor-errors.jsonl');
  const memory = new Memory(join(dir, 'memory'), compress, () => {}, budget, 8, retryMs, log);
  try {
    await run(memory, log);
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('failures are busy, transient or permanent', () => {
  assert.equal(classify(new CompactorError('429 rate limited', 429)), 'busy');
  assert.equal(classify(new Error('529 {"type":"overloaded_error"}')), 'busy');
  assert.equal(classify(new Error('Connection error.')), 'transient');
  assert.equal(classify(new Error('terminated')), 'transient');
  assert.equal(classify(new Error('connect ECONNREFUSED 127.0.0.1:443')), 'transient');
  assert.equal(classify(new Error('Connection refused')), 'transient');
  assert.equal(classify(new Error('The model stopped with a refusal')), 'permanent');
  assert.equal(classify(new Error('500 {"type":"api_error"}')), 'transient');
  assert.equal(classify(new Error('401 {"type":"authentication_error"}')), 'transient', 'a lapsed login is not the node');
  assert.equal(classify(new Error(BLOCKED)), 'permanent', 'blocked without a status');
  assert.equal(classify(new CompactorError(BLOCKED, 403)), 'permanent', 'blocked with a status');
  assert.equal(classify(new Error('400 {"type":"error","error":{"type":"invalid_request_error"}}')), 'permanent');
  assert.equal(classify(new Error('Compactor returned no text.')), 'permanent');
});

test('a leaf the provider blocks is tried 3 times, spaced out, then built from a marked fallback line without its text', async () => {
  const calls: number[] = [];
  await withMemory(
    async () => {
      calls.push(Date.now());
      throw new Error(BLOCKED);
    },
    async (memory, log) => {
      memory.append('echo', `paseo agent logs output\n${'line of output '.repeat(80)}`, '2026-10-11T09:00:00.000Z');
      await memory.settle(AbortSignal.timeout(5000), true);
      assert.equal(calls.length, 3, 'never called again after the third refusal');
      assert.ok(calls[2] - calls[1] > calls[1] - calls[0], `spaced out: ${calls}`);
      const node = memory.node({ l: 0, i: 0 })!;
      assert.equal(node.text, `echo (2026-10-11, ${memory.root[0].size} bytes, not summarised: blocked by the provider)`);
      // Neither the line nor the bot's view carries any of the blocked text.
      for (const text of [node.text, memory.render()]) assert.ok(!/paseo|output/.test(text), text);
      const errors = lines(log);
      assert.equal(errors.length, 3);
      assert.deepEqual(
        errors.map(e => e.fallback),
        [undefined, undefined, true],
      );
      assert.equal(errors[2].retryAt, undefined);
      assert.equal(memory.lastError, undefined);
    },
  );
});

test('a merge the provider refuses is built from facts about its messages, without their text', async () => {
  await withMemory(
    async input => {
      throw new CompactorError(`400 merge ${input.merge}`, 400);
    },
    async memory => {
      // Each 300-byte message is its own line; their merge needs the compactor.
      memory.append('user', 'a'.repeat(300), '2026-10-10T23:00:00.000Z');
      memory.append('echo', 'b'.repeat(300), '2026-10-11T09:00:00.000Z');
      await memory.settle(AbortSignal.timeout(5000), true);
      const merged = memory.node({ l: 1, i: 0 })!;
      assert.equal(merged.text, '(not summarised: HTTP 400) messages 0-1, 612 bytes, 2026-10-10 to 2026-10-11, kinds: user 1, echo 1');
      assert.ok(bytes(merged.text) <= NODE);
    },
    { budget: 500 },
  );
});

test('a transient failure retries the node after a doubling delay, and never falls back', async () => {
  const calls: number[] = [];
  await withMemory(
    async input => {
      calls.push(Date.now());
      if (calls.length <= 4) throw new Error(calls.length % 2 ? 'terminated' : 'Connection error.');
      return input.source.slice(0, 100);
    },
    async (memory, log) => {
      memory.append('user', long(0));
      await memory.settle(AbortSignal.timeout(5000), true);
      const gaps = calls.slice(1).map((at, k) => at - calls[k]);
      assert.equal(calls.length, 5);
      assert.doesNotMatch(memory.node({ l: 0, i: 0 })!.text, /not summarised/);
      const errors = lines(log);
      assert.ok(errors.every(e => e.fallback === undefined && e.retryAt));
      const waits = errors.map(e => Date.parse(e.retryAt) - Date.parse(e.time));
      assert.deepEqual(
        waits.map(w => Math.round(w / 10)),
        [1, 2, 4, 8],
      );
      // The scheduled waits double (above); each real gap honours its wait. Comparing gaps with each
      // other flaked under load (15,29,41,84: scheduling overhead is added to every gap).
      gaps.forEach((gap, k) => assert.ok(gap >= waits[k] - 2, `gap ${k} ${gap}ms < wait ${waits[k]}ms (${gaps})`));
    },
  );
});

test('busy answers hold the compactor as before and never count towards a fallback', async () => {
  const until = Date.now() + 400;
  let failures = 0;
  await withMemory(
    async input => {
      if (Date.now() < until) {
        failures++;
        throw new CompactorError('503 busy', 503);
      }
      return input.source.slice(0, 100);
    },
    async memory => {
      memory.append('user', long(0));
      await memory.settle(AbortSignal.timeout(5000), true);
      assert.ok(failures > 3, `${failures} busy answers`);
      assert.equal(memory.node({ l: 0, i: 0 })!.text, `user: ${long(0)}`.slice(0, 100));
    },
  );
});

test('a turn is not held by a node the provider keeps refusing', async () => {
  let calls = 0;
  await withMemory(
    async () => {
      calls++;
      throw new Error(BLOCKED);
    },
    async memory => {
      memory.append('user', 'a short message that is its own line');
      memory.append('echo', long(1));
      const began = Date.now();
      await memory.settle(AbortSignal.timeout(2000));
      assert.ok(Date.now() - began < 1000);
      assert.equal(calls, 2, 'the turn waits through one failure, not more');
      assert.equal(memory.node({ l: 0, i: 1 }), undefined);
      assert.match(memory.render(), /1\+1\|\(not summarized yet: zoom it\)/);
      assert.match(memory.render(), /0\+1\|user: a short message/);
      await memory.settle(AbortSignal.timeout(5000), true);
      assert.match(memory.node({ l: 0, i: 1 })!.text, /not summarised/);
    },
    { retryMs: 150 },
  );
});
