import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BLOCK_LINES, cachePayload, markedPrefix, viewBlocks } from '../src/cache.ts';

/** A turn payload as Pi 1.1.0 sent it to Anthropic for Opus 5.5 (OAuth), with Pi's own marks still on, before OptChat's hook.
 * The system prompt is shortened and the view replaced by 30 synthetic lines (about 9 KB, well under 50k characters). */
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/anthropic-turn-payload.json', import.meta.url), 'utf8'));
const marks = (value: unknown) => (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;
type Block = { type: string; text?: string; cache_control?: unknown };

test('a captured turn payload with a small view gets a mark on its last whole 4-line block, before the new message', () => {
  const payload = fixture();
  const view: string = payload.messages[0].content[0].text;
  assert.ok(view.length < 50_000);
  const sent = cachePayload(payload) as typeof payload;
  const content: Block[] = sent.messages[0].content;
  assert.equal(content.length, Math.ceil(30 / BLOCK_LINES) + 1, '7 whole blocks, the last 2 lines with </chat>, then the message');
  assert.equal(
    content
      .slice(0, -1)
      .map(b => b.text)
      .join(''),
    view,
    'the view is kept byte for byte',
  );
  const marked = content.findIndex(b => b.cache_control);
  assert.equal(marked, 6, 'the mark sits on the last whole block');
  assert.equal(content[marked].text!.split('\n').filter(Boolean).at(-1)!.split('|')[0], '27+1');
  assert.equal(content.at(-1)!.text, 'What did we decide about the cache marks?');
  assert.equal(content.at(-1)!.cache_control, undefined);
  assert.deepEqual(sent.cache_control, { type: 'ephemeral' }, 'the end of the request keeps its automatic mark');
  assert.deepEqual(sent.system.at(-1).cache_control, { type: 'ephemeral' }, 'tools and system prompt are cached on their own');
  assert.equal(sent.tools.filter((t: Block) => t.cache_control).length, 0);
  assert.equal(marks(sent), 3);
});

test('the next turn finds the last mark again: its marked prefix grows only at the end', () => {
  const line = (i: number) => `${i}+1|user: message ${i} with a few words`;
  const view = (n: number) => `<chat>\n${Array.from({ length: n }, (_, i) => line(i)).join('\n')}\n</chat>`;
  for (let n = 0; n < 40; n++) {
    const { blocks, whole } = viewBlocks(view(n));
    assert.equal(blocks.join(''), view(n));
    assert.equal(whole, Math.floor(n / BLOCK_LINES));
    assert.ok(view(n + 1).startsWith(markedPrefix(view(n))));
    assert.ok(markedPrefix(view(n + 1)).startsWith(markedPrefix(view(n))));
  }
  assert.equal(markedPrefix(view(3)), '', 'under 4 lines there is no whole block to mark');
});

test('a large view still has at most 4 marks and every character', () => {
  const view = `<chat>\n${'0+1|summary of a decision\n'.repeat(2000)}0+1|the summary quotes </chat> in passing\n${'0+1|x\n'.repeat(3501)}</chat>`;
  const payload = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'zoom', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: view },
          { type: 'text', text: 'new question', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
  const sent = cachePayload(payload) as typeof payload;
  assert.ok(marks(sent) <= 4);
  assert.equal(marks(sent), 3);
  assert.equal(sent.messages[0].content.map(b => b.text).join(''), view + 'new question');
});
