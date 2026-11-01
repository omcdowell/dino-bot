import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { CAP, Memory } from '../src/memory.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { RunLog } from '../src/transcript.ts';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AgentMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'test',
  model: 'test',
  usage,
  stopReason,
  timestamp: 1,
});
const call = (id: string, name: string, args: Record<string, string>) => ({ type: 'toolCall' as const, id, name, arguments: args });
const output = (id: string, name: string, text: string, isError = false): AgentMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text }],
  isError,
  timestamp: 2,
});

function withMemory(run: (memory: Memory) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-digest-'));
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

test('a run with tool steps is logged as user, one tool digest, then the final reply', () =>
  withMemory(memory => {
    const log = new RunLog(memory, true);
    log.write({ role: 'user', content: 'Fix the failing test', timestamp: 0 });
    log.write(assistant([{ type: 'text', text: 'Looking at the test first.' }, call('1', 'read', { path: 'test/a.test.ts' })]));
    log.write(output('1', 'read', 'line one\nline two'));
    log.write(assistant([call('2', 'bash', { command: 'npm test' }), call('3', 'edit', { path: 'src/a.ts' })]));
    log.write(output('2', 'bash', 'x'.repeat(5000), true));
    log.write(output('3', 'edit', 'Edited src/a.ts'));
    log.write(assistant([{ type: 'text', text: 'Fixed: the off-by-one in a.ts.' }], 'stop'));
    log.end();
    assert.deepEqual(
      memory.root.map(e => e.kind),
      ['user', 'tool', 'talk'],
    );
    const digest = memory.root[1].text;
    assert.match(digest, /^Tool steps \(3 calls\):/);
    assert.match(digest, /note: Looking at the test first\./);
    assert.match(digest, /- read \{"path":"test\/a\.test\.ts"\}\n  → ok: line one line two/);
    assert.match(digest, /- bash \{"command":"npm test"\}\n  → error: x+… \(5000 chars\)/);
    assert.match(digest, /- edit \{"path":"src\/a\.ts"\}\n  → ok: Edited src\/a\.ts/);
    assert.ok(digest.length < 1500, 'results are clipped to a short excerpt');
  }));

test('steering mid-run and an aborted run flush the pending digest first, keeping order', () =>
  withMemory(memory => {
    const log = new RunLog(memory, true);
    log.write({ role: 'user', content: 'Start', timestamp: 0 });
    log.write(assistant([call('1', 'bash', { command: 'ls' })]));
    log.write(output('1', 'bash', 'a b c'));
    log.write({ role: 'user', content: 'Actually, stop after listing', timestamp: 3 });
    log.write(assistant([call('2', 'bash', { command: 'sleep 100' })]));
    log.write(assistant([], 'aborted'));
    log.end();
    assert.deepEqual(
      memory.root.map(e => `${e.kind}:${e.text.split('\n')[0]}`),
      [
        'user:Start',
        'tool:Tool steps (1 call):',
        'user:Actually, stop after listing',
        'tool:Tool steps (1 call):',
        'echo:Agent aborted: No further details',
      ],
    );
  }));

test('end() is safe to call twice and without steps; digest off logs every step as before', () =>
  withMemory(memory => {
    const quiet = new RunLog(memory, true);
    quiet.end();
    quiet.end();
    assert.equal(memory.root.length, 0);
    const full = new RunLog(memory, false);
    full.write(assistant([call('1', 'read', { path: 'a' })]));
    full.write(output('1', 'read', 'contents'));
    full.end();
    assert.deepEqual(
      memory.root.map(e => e.kind),
      ['tool', 'echo'],
    );
  }));

test('by default every tool call and its full result are logged, the result capped at 30,000 characters', () =>
  withMemory(memory => {
    assert.equal(DEFAULT_SETTINGS.toolDigest, false);
    const log = new RunLog(memory, DEFAULT_SETTINGS.toolDigest);
    log.write({ role: 'user', content: 'Run the tests', timestamp: 0 });
    log.write(assistant([{ type: 'text', text: 'Running them.' }, call('1', 'bash', { command: 'npm test' })]));
    log.write(output('1', 'bash', `head ${'x'.repeat(50_000)} tail`));
    log.write(assistant([{ type: 'text', text: 'All pass.' }], 'stop'));
    log.end();
    assert.deepEqual(
      memory.root.map(e => e.kind),
      ['user', 'talk', 'tool', 'echo', 'talk'],
    );
    const result = memory.root[3].text;
    assert.ok(result.length <= CAP && result.startsWith('bash: head') && result.endsWith('x tail'));
    assert.match(result, /characters omitted; head and tail retained/);
  }));
