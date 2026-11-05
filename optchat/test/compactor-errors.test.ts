import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Memory, type Compression } from '../src/memory.ts';
import { createCompressor } from '../src/compactor.ts';
import { CompactorError, failureOf, parseFailure, retryAfterMs } from '../src/provider-error.ts';

const long = (i: number) => `Message ${i}: ${'detail '.repeat(100)}`;
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
    : [];

test('each failed compaction is appended to compactor-errors.jsonl with its time, node, error and status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-errors-'));
  const log = join(dir, 'compactor-errors.jsonl');
  let calls = 0;
  const memory = new Memory(
    join(dir, 'memory'),
    async (input: Compression) => {
      if (calls++ < 2) throw new Error('500 {"type":"error","error":{"type":"api_error","message":"boom"}}');
      return input.source.slice(0, 100);
    },
    () => {},
    128_000,
    1,
    10,
    log,
  );
  try {
    memory.append('user', long(0));
    await memory.settle(AbortSignal.timeout(5000), true);
    const errors = lines(log);
    assert.equal(errors.length, 2, 'every failure, not just the first warning');
    for (const e of errors) {
      assert.equal(e.node, '0+1');
      assert.equal(e.status, 500);
      assert.match(e.error, /^500 .*boom/);
      assert.ok(!Number.isNaN(Date.parse(e.time)) && e.time.endsWith('Z'));
      assert.ok(Date.parse(e.retryAt) >= Date.parse(e.time));
      assert.equal(e.retryAfter, undefined);
    }
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A provider that answers 429 until `until`, with or without a Retry-After for the time left. */
function busyProvider(ms: number, status: number, withHeader: boolean) {
  const until = Date.now() + ms,
    calls: { at: number; ok: boolean }[] = [];
  const compress = async (input: Compression) => {
    const now = Date.now();
    await new Promise(resolve => setTimeout(resolve, 2));
    if (now < until) {
      calls.push({ at: now, ok: false });
      throw new CompactorError(`${status} busy`, status, withHeader ? until - now : undefined);
    }
    calls.push({ at: now, ok: true });
    return input.source.slice(0, 100);
  };
  return { until, calls, compress };
}

test('a 429 with Retry-After holds the whole compactor until then, then one call goes first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-busy-'));
  const { until, calls, compress } = busyProvider(400, 429, true);
  const log = join(dir, 'compactor-errors.jsonl');
  const memory = new Memory(join(dir, 'memory'), compress, () => {}, 128_000, 8, 20, log);
  try {
    for (let i = 0; i < 6; i++) memory.append('user', long(i));
    await memory.settle(AbortSignal.timeout(5000), true);
    const failures = calls.filter(c => !c.ok);
    // With a fixed 20 ms retry, six pending messages would have failed about 120 times in 400 ms.
    assert.ok(failures.length <= 6, `${failures.length} failed calls`);
    assert.ok(
      failures.every(c => c.at < failures[0].at + 50),
      'only the first burst fails',
    );
    const after = calls.filter(c => c.ok);
    assert.ok(after[0].at >= until - 5, 'nothing starts before the Retry-After has passed');
    assert.ok(after.length >= 6);
    assert.ok(after[1].at >= after[0].at + 1, 'one call goes first, the rest after it succeeds');
    const errors = lines(log);
    assert.ok(errors.length === failures.length && errors.every(e => e.status === 429 && e.retryAfter === 0));
    assert.ok(errors.every(e => Date.parse(e.retryAt) >= until - 5));
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy answer without Retry-After backs off exponentially, for the whole compactor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-busy-'));
  const { calls, compress } = busyProvider(600, 503, false);
  const memory = new Memory(join(dir, 'memory'), compress, () => {}, 128_000, 8, 20);
  try {
    for (let i = 0; i < 6; i++) memory.append('user', long(i));
    await memory.settle(AbortSignal.timeout(5000), true);
    const probes = calls.filter(c => !c.ok).slice(6); // after the first burst, one call per back-off
    const gaps = probes.slice(1).map((c, k) => c.at - probes[k].at);
    assert.ok(probes.length >= 2 && probes.length <= 5, `${probes.length} probes`);
    for (let k = 1; k < gaps.length; k++) assert.ok(gaps[k] >= gaps[k - 1] * 1.5, `gaps double: ${gaps}`);
    assert.equal(memory.pending, 0);
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Retry-After is read from headers in milliseconds, seconds or as a date, and status from an SDK message', () => {
  const now = Date.parse('2026-10-08T10:00:00Z');
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '120' }), now), 120_000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' }), now), 1500);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Thu, 08 Oct 2026 10:02:00 GMT' }), now), 120_000);
  assert.equal(retryAfterMs(new Headers({}), now), undefined);
  assert.deepEqual(parseFailure('429 {"type":"error","error":{"type":"rate_limit_error"}}'), { status: 429 });
  assert.deepEqual(parseFailure('Server requested 300s retry delay (max: 60s). 429 …'), { retryAfterMs: 300_000 });
  assert.deepEqual(parseFailure('Connection error.'), {});
  assert.deepEqual(failureOf(new CompactorError('overloaded', 529, 5000)), { status: 529, retryAfterMs: 5000 });
});

test("the compactor keeps a failed Anthropic response's status and Retry-After, which the SDK drops", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-429-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Consumer "alice" exceeded quota (five_hour).' } }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1800' },
      },
    );
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(dir, 'models.json'),
      refreshOnCreate: false,
    });
    runtime.registerProvider('quota-test', {
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'synthetic',
      api: 'anthropic-messages',
      models: [
        {
          id: 'compactor',
          name: 'Synthetic compactor',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 1000,
        },
      ],
    });
    const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'quota-test', model: 'compactor', thinking: 'off' }));
    const error = await compress(
      { context: '<chat>\n</chat>', source: 'user: ' + 'x'.repeat(600), merge: false },
      new AbortController().signal,
    ).then(
      () => assert.fail('expected a 429'),
      (e: unknown) => e,
    );
    assert.ok(error instanceof CompactorError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 1_800_000);
    assert.match(error.message, /429/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
