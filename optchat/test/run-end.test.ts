import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { runEnd } from '../src/controller.ts';
import { emptyUsage } from '../src/usage.ts';

const reply = (stopReason: 'stop' | 'error', errorMessage?: string): AgentMessage => ({
  role: 'assistant',
  content: stopReason === 'stop' ? [{ type: 'text', text: 'Done.' }] : [],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  usage: emptyUsage(),
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: 1,
});
const user: AgentMessage = { role: 'user', content: 'Go on.', timestamp: 0 };

test('a run that ends well logs a plain end entry', () => {
  assert.deepEqual(runEnd([user, reply('stop')]), { state: 'end' });
  assert.deepEqual(runEnd([user, reply('error', '429 x'), reply('stop')]), { state: 'end' }, 'only the last reply counts');
});

test("a run that fails logs the provider's status, and its Retry-After when the error gives it", () => {
  const quota = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Consumer \\"alice\\" exceeded quota (five_hour)."}}';
  assert.deepEqual(runEnd([user, reply('error', quota)]), { state: 'end', error: { message: quota, status: 429 } });
  const now = Date.parse('2026-10-08T10:00:00Z');
  const delayed = 'Server requested 1800s retry delay (max: 60s). 429 rate limited';
  assert.deepEqual(runEnd([user, reply('error', delayed)], now), {
    state: 'end',
    error: { message: delayed, retryAfter: 1800, retryAt: '2026-10-08T10:30:00.000Z' },
  });
  assert.deepEqual(runEnd([user, reply('error')]), { state: 'end', error: { message: 'No further details' } });
});
