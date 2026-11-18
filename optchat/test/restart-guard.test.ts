import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureIo, REFUSAL, restartGuard, restartReason, type GuardIo } from '../src/restart-guard.ts';
import { ALLOW, FIXTURE, OWN_ID, REFUSE } from './restart-guard-cases.ts';

const io: GuardIo = fixtureIo(FIXTURE);
const refused = (cmd: string) => restartReason(cmd, '/bot', io, OWN_ID) !== null;

test('refuses restarts, stops and reloads of DinoBot, wrapped or not', () => {
  for (const cmd of REFUSE) assert.equal(refused(cmd), true, cmd);
});

test('lets ordinary commands through, including ones that only mention a restart', () => {
  for (const cmd of ALLOW) assert.equal(refused(cmd), false, cmd);
});

test('the refusal names bot-restart, on one line', () => {
  assert.equal(restartReason('paseo daemon restart', '/', io), REFUSAL);
  assert.match(REFUSAL, /bot-restart/);
  assert.doesNotMatch(REFUSAL, /\n/);
});

test('fails open: an io error or odd input lets the command through', () => {
  const broken: GuardIo = {
    readFile: () => {
      throw new Error('boom');
    },
    cgroupOf: () => {
      throw new Error('boom');
    },
    pgrep: () => {
      throw new Error('boom');
    },
  };
  assert.equal(restartReason('pkill -f "paseo daemon"', '/bot', broken), null);
  assert.equal(restartReason('bash ./apply.sh', '/bot', broken), null);
  assert.equal(restartReason('kill 4242', '/bot', broken), null);
  assert.equal(restartReason('"unterminated \'quote $( (( ` <<', '/bot', io), null);
  assert.equal(restartReason('x'.repeat(300_000), '/bot', io), null);
});

test('hook: installed only in a bot session; blocks bash only; never throws', async () => {
  const handlers: Array<(e: any, c: any) => unknown> = [];
  const pi = { on: (_: 'tool_call', h: (e: any, c: any) => unknown) => handlers.push(h) };
  restartGuard(pi, {});
  assert.equal(handlers.length, 0);
  restartGuard(pi, { PASEO_AGENT_ID: 'abc' });
  assert.equal(handlers.length, 1);
  const h = handlers[0]!;
  assert.deepEqual(h({ toolName: 'bash', input: { command: 'paseo plugin reload bots' } }, { cwd: '/' }), { block: true, reason: REFUSAL });
  assert.equal(h({ toolName: 'bash', input: { command: 'ls' } }, { cwd: '/' }), undefined);
  assert.equal(h({ toolName: 'write', input: { path: 'x', content: 'paseo daemon restart' } }, { cwd: '/' }), undefined);
  assert.equal(h(null, null), undefined);
  assert.equal(h({ toolName: 'bash', input: { command: 42 } }, undefined), undefined);
});

test('ordinary commands are fast', () => {
  const cmd = 'cd ~/code/x && git status && npm test 2>&1 | tail -20';
  const t = performance.now();
  for (let i = 0; i < 1000; i++) restartReason(cmd, '/bot', io);
  assert.ok(performance.now() - t < 500, 'under 0.5 ms per call');
});

test('without its own agent id (not a real bot session) every agent reload is refused', () => {
  assert.equal(restartReason('paseo agent reload 72a13b6', '/bot', io, ''), REFUSAL);
  assert.equal(restartReason('paseo agent reload 72a13b6', '/bot', io), REFUSAL);
});
