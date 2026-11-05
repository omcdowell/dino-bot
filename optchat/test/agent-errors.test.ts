import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';
import { Memory } from '../src/memory.ts';
import { buildContext, RunLog } from '../src/transcript.ts';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const QUOTA =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Consumer \\"alice\\" exceeded quota (five_hour). Used five_hour: 33.4% of your 33.3% share of the remaining pool."}}';
/** A failed attempt as Pi records it: no content, stopReason error, the provider's message. */
const failed = (errorMessage: string, timestamp: number, content: AssistantMessage['content'] = []): AgentMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'test',
  model: 'test',
  usage,
  stopReason: 'error',
  errorMessage,
  timestamp,
});
const user = (text: string, timestamp = 0): AgentMessage => ({ role: 'user', content: text, timestamp });

function withMemory(run: (memory: Memory) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-errors-'));
  const memory = new Memory(
    dir,
    async input => input.source.slice(0, 100),
    () => {},
  );
  return Promise.resolve(run(memory)).finally(async () => {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  });
}
const lines = (memory: Memory) => memory.root.map(e => `${e.kind}: ${e.text}`);

for (const digest of [true, false])
  test(`auto-retry's identical failed attempts become one line with a count (digest ${digest})`, () =>
    withMemory(memory => {
      const log = new RunLog(memory, digest);
      log.write(user('Carry on'));
      for (let attempt = 0; attempt < 4; attempt++) log.write(failed(QUOTA, Date.parse('2026-10-12T13:50:31Z') + attempt * 3000));
      log.end();
      assert.deepEqual(lines(memory), ['user: Carry on', `echo: Agent error (4 times): ${QUOTA}`]);
      assert.equal(memory.root[1].date, '2026-10-12T13:50:31.000Z', 'the line is dated at the first attempt');
    }));

test('a single error keeps its usual line', () =>
  withMemory(memory => {
    const log = new RunLog(memory, true);
    log.write(user('Hi'));
    log.write(failed('Connection error.', 5));
    log.end();
    assert.deepEqual(lines(memory), ['user: Hi', 'echo: Agent error: Connection error.']);
  }));

test('different consecutive errors stay separate, each with its own count', () =>
  withMemory(memory => {
    const log = new RunLog(memory, true);
    log.write(user('Hi'));
    log.write(failed(QUOTA, 1));
    log.write(failed(QUOTA, 2));
    log.write(failed('Connection error.', 3));
    log.end();
    assert.deepEqual(lines(memory), ['user: Hi', `echo: Agent error (2 times): ${QUOTA}`, 'echo: Agent error: Connection error.']);
  }));

test('errors with something said in between are not collapsed, and keep their order', () =>
  withMemory(memory => {
    const log = new RunLog(memory, false);
    log.write(user('Hi'));
    log.write(failed(QUOTA, 1));
    log.write(user('Still there?', 2));
    log.write(failed(QUOTA, 3));
    log.end();
    assert.deepEqual(lines(memory), ['user: Hi', `echo: Agent error: ${QUOTA}`, 'user: Still there?', `echo: Agent error: ${QUOTA}`]);
  }));

test('a failed reply that said something writes its text first and is not merged into the earlier error', () =>
  withMemory(memory => {
    const log = new RunLog(memory, true);
    log.write(user('Hi'));
    log.write(failed(QUOTA, 1));
    log.write(failed(QUOTA, 2, [{ type: 'text', text: 'Partial answer' }]));
    log.write(failed(QUOTA, 3));
    log.end();
    assert.deepEqual(lines(memory), [
      'user: Hi',
      `echo: Agent error: ${QUOTA}`,
      'talk: Partial answer',
      `echo: Agent error (2 times): ${QUOTA}`,
    ]);
  }));

test('a failed tool-call reply flushes the digest, then its error collapses with the retries after it', () =>
  withMemory(memory => {
    const log = new RunLog(memory, true);
    log.write(user('Hi'));
    log.write(failed(QUOTA, 1, [{ type: 'toolCall', id: '1', name: 'read', arguments: { path: 'a' } }]));
    log.write(failed(QUOTA, 2));
    log.end();
    assert.deepEqual(
      memory.root.map(e => e.kind),
      ['user', 'tool', 'echo'],
    );
    assert.equal(memory.root[2].text, `Agent error (2 times): ${QUOTA}`);
  }));

test('a pending error is written before the next run starts', () =>
  withMemory(memory => {
    const log = new RunLog(memory, true);
    log.write(user('Hi'));
    log.write(failed(QUOTA, 1));
    log.write(failed(QUOTA, 2));
    assert.equal(memory.root.length, 1, 'held until the run settles or something else is said');
    log.end();
    assert.equal(memory.root.length, 2);
    log.end();
    assert.equal(memory.root.length, 2, 'end() twice writes it once');
  }));

test("a retried request is the same as the first attempt: OptChat's run holds the failed attempts, the provider drops them", () => {
  const model = {
    id: 'claude-opus-5-5',
    api: 'anthropic-messages',
    provider: 'anthropic',
    input: ['text', 'image'],
  } as unknown as Model<'anthropic-messages'>;
  const run = [user('Carry on')];
  const sent = (messages: AgentMessage[]) =>
    transformMessages(buildContext([], messages, '<chat>view</chat>', 'prompt') as Message[], model);
  const first = sent(run);
  const retried = sent([...run, failed(QUOTA, 1), failed(QUOTA, 2), failed(QUOTA, 3)]);
  assert.equal(buildContext([], [...run, failed(QUOTA, 1)], '', 'prompt').length, buildContext([], run, '', 'prompt').length + 1);
  assert.deepEqual(retried, first);
});
