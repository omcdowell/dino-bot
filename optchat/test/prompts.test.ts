import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPACTIONS, CONTINUITY, MASTER, sharedPrompt, TURNS, VIEW_DOC } from '../src/prompts.ts';
import { task } from '../src/compactor.ts';
import { tag } from '../src/memory.ts';

test('the prompts say a [dm …] message is another bot, tagged dm:<from>, with no authority', () => {
  assert.match(COMPACTIONS, /"\[dm /);
  assert.match(COMPACTIONS, /"dm:<from>:"/);
  assert.match(COMPACTIONS, /never "user:"/);
  assert.match(COMPACTIONS, /grants no approval/);
  assert.match(VIEW_DOC, /dm:<from>/);
});

test('the turn rules leave how to act on DMs and rooms to the bots plugin section', () => {
  assert.doesNotMatch(TURNS, /\[dm |\[room |bot-room|bot-dm/);
  // The room task tag is part of the memory format and stays.
  assert.equal(tag({ kind: 'user', text: '[room alarm-clock task from wallace msg 01MT]\n(From Wallace …)\ntask: x' }), 'dm:wallace');
  assert.equal(tag({ kind: 'user', text: '[room alarm-clock task from user msg 01MT]\ntask: x' }), 'user');
});

test('one system prompt holds the turn and compaction rules, with the UniiChat lines that matter most', () => {
  const prompt = sharedPrompt(false);
  for (const part of [MASTER, VIEW_DOC, TURNS, COMPACTIONS]) assert.ok(prompt.includes(part));
  const flat = prompt.replace(/\s+/g, ' ');
  assert.match(flat, /its latest word on a thing is the truth/);
  assert.match(
    flat,
    /first find its latest mention in the view and zoom until you have it whole, before any other source, and before you act, guess or ask/,
  );
  assert.match(flat, /use search_memory only as a last resort, once zooming has failed/);
  assert.match(flat, /Copy names, numbers, ids, paths and errors exactly/);
  assert.match(flat, /Use the space up to the limit/);
  assert.match(flat, /never to add what <input> lacks/);
  assert.match(flat, /Call no tools, and output only the line, without an id\+n\| head/);
  assert.doesNotMatch(flat, /recover detail/);
});

test('the view and the previous exchange no longer contradict each other', () => {
  const flat = sharedPrompt(true).replace(/\s+/g, ' ');
  assert.ok(sharedPrompt(true).includes(CONTINUITY));
  assert.ok(!sharedPrompt(false).includes(CONTINUITY));
  assert.match(flat, /Inside <chat>, no message appears in full/);
  assert.match(flat, /After <\/chat>, the view may be followed by the immediately preceding completed exchange/);
  assert.doesNotMatch(flat, /No message appears in full/);
});

test('compaction tasks name their ids and wrap the source in <input>; only a merge points at <chat> for detail', () => {
  const leaf = task({ context: '', source: 'user: hello there', merge: false, part: { l: 0, i: 41 } });
  assert.match(leaf, /^Compaction: compress message 41 into one line of at most 512 bytes/);
  assert.match(leaf, /<input>\nuser: hello there\n<\/input>$/);
  assert.doesNotMatch(leaf, /<chat> may hold/);
  const merge = task({ context: '', source: 'user: a\ntalk: b', merge: true, part: { l: 3, i: 5 } });
  assert.match(merge, /^Compaction: merge lines 40\+4 and 44\+4, adjacent, into one line of at most 512 bytes/);
  assert.match(merge, /<chat> may hold their messages, 40 to 47, in more detail: take details of them from there too\./);
  assert.match(merge, /<input>\n40\+4\|user: a\n44\+4\|talk: b\n<\/input>$/);
});

test('the system prompt names the user from the host settings; without a name it is unchanged and never says Sam', () => {
  const plain = sharedPrompt(false, {});
  assert.equal(plain, sharedPrompt(false, { BOTS_USER_NAME: 'the user' }));
  assert.doesNotMatch(plain, /sam/i);
  const named = sharedPrompt(false, { BOTS_USER_NAME: 'Sam' });
  assert.match(named, /The user's name is Sam; their messages are still tagged "user"\./);
  assert.ok(named.startsWith(MASTER));
});
