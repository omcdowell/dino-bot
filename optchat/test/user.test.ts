import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalateTo, isUser, normalizeParty, userAliases, userName } from '../src/user.ts';
import { tag } from '../src/memory.ts';
import { roomPrompt } from '../src/room/prompt.ts';

test('user settings from the env the paseo-bots plugin sets; public defaults without it', () => {
  assert.equal(userName({}), 'the user');
  assert.equal(userName({ BOTS_USER_NAME: ' Sam ' }), 'Sam');
  assert.deepEqual(userAliases({ BOTS_USER_ALIASES: 'Sam, ,user' }), ['sam']);
  assert.equal(isUser('user', {}), true);
  assert.equal(isUser('sam', {}), false);
  assert.equal(isUser('sam', { BOTS_USER_ALIASES: 'sam' }), true);
  assert.equal(normalizeParty('sam', { BOTS_USER_ALIASES: 'sam' }), 'user');
  assert.equal(escalateTo({}), null);
  assert.equal(escalateTo({ BOTS_ESCALATE_TO: 'coordinator' }), 'coordinator');
});

test('a room task from the user stays the user; an old one from an alias too when the alias is set', () => {
  assert.equal(tag({ kind: 'user', text: '[room g task from user msg 01M4]\nx' }), 'user');
  const before = process.env.BOTS_USER_ALIASES;
  process.env.BOTS_USER_ALIASES = 'sam';
  try {
    assert.equal(tag({ kind: 'user', text: '[room g task from sam msg 01M4]\nx' }), 'user');
  } finally {
    if (before === undefined) delete process.env.BOTS_USER_ALIASES;
    else process.env.BOTS_USER_ALIASES = before;
  }
  assert.equal(tag({ kind: 'user', text: '[room g task from sam msg 01M4]\nx' }), 'dm:sam', 'without the alias it is a bot');
});

test('the room prompt names the user from the settings and uses the code user', () => {
  const p = roomPrompt('wallace', 'g', 'Robin');
  assert.match(p, /with Robin \(the user, code user\)/);
  assert.doesNotMatch(p, /\bsam\b/i, 'no other name is hard-wired');
});
