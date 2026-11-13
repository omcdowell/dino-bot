import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { cachePayload, TurnPrefix } from '../src/cache.ts';
import { createCompressor } from '../src/compactor.ts';
import { COMPACTIONS, compactorPrompt, sharedPrompt } from '../src/prompts.ts';
import { Memory, end, start } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { CacheModel } from './cache-model.ts';
import { textContent } from '../src/transcript.ts';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/anthropic-turn-payload.json', import.meta.url), 'utf8'));
type Payload = Record<string, unknown> & { messages: { role: string; content: Record<string, unknown>[] }[] };

/** A compactor on a fake Anthropic provider that builds its payload as pi-ai does and passes it to `onPayload`. */
async function setup(provider = 'anthropic', own?: () => string) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-share-'));
  const sent: Payload[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(dir, 'models.json'),
    refreshOnCreate: false,
  });
  let n = 0;
  runtime.registerProvider(provider, {
    baseUrl: 'https://invalid.local',
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
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: `line ${n++} `.padEnd(420, 'z') }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        usage: emptyUsage(),
      };
      void (async () => {
        const system = context.messages.find(m => m.role === 'system');
        const payload = {
          model: model.id,
          system: [{ type: 'text', text: textContent(system?.content), cache_control: { type: 'ephemeral' } }],
          messages: context.messages
            .filter(m => m.role !== 'system')
            .map(m => ({
              role: m.role,
              content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map(c => ({ ...c })),
            })),
        };
        sent.push(((await options?.onPayload?.(payload, model)) ?? payload) as Payload);
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const turn = new TurnPrefix();
  const compress = createCompressor(
    new ModelRegistry(runtime),
    () => ({ provider, model: 'compactor', thinking: 'off' }),
    undefined,
    undefined,
    turn,
    own ?? (() => 'FALLBACK PROMPT'),
  );
  return { dir, sent, turn, compress };
}
const view = '<chat>\n0+1|user: an old line\n</chat>';
const source = 'user: ' + 'a long message '.repeat(70);

test('compactions send the last turn’s system prompt and tools byte for byte, and their own prompt before any turn', async () => {
  const { dir, sent, turn, compress } = await setup();
  try {
    await compress({ context: view, source, merge: false, part: { l: 0, i: 1 } }, new AbortController().signal);
    assert.deepEqual(sent[0].system, [{ type: 'text', text: 'FALLBACK PROMPT', cache_control: { type: 'ephemeral' } }]);
    assert.equal(sent[0].tools, undefined, 'no turn yet: no tools');
    const turnPayload = fixture();
    turnPayload.system.push({ type: 'text', text: sharedPrompt(false, {}) });
    const payload = cachePayload(turnPayload) as Payload;
    turn.capture('anthropic', payload, 'compactor');
    await compress({ context: view, source, merge: false, part: { l: 0, i: 1 } }, new AbortController().signal);
    assert.equal(JSON.stringify(sent[1].system), JSON.stringify(payload.system));
    assert.equal(JSON.stringify(sent[1].tools), JSON.stringify(payload.tools));
    assert.match(String(sent[1].messages[0].content.at(-1)!.text), /^Compaction:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a turn prefix is only captured from a turn, and only reused on the same provider', async () => {
  const { dir, sent, turn, compress } = await setup('other');
  try {
    turn.capture('anthropic', {
      system: [{ type: 'text', text: 'not a turn' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    assert.equal(turn.captured, false);
    const turnPayload = fixture();
    turnPayload.system.push({ type: 'text', text: sharedPrompt(false, {}) });
    const payload = cachePayload(turnPayload) as Payload;
    turn.capture('anthropic', payload, 'compactor');
    assert.equal(turn.captured, true);
    await compress({ context: view, source, merge: false }, new AbortController().signal);
    assert.match(JSON.stringify(sent[0].system), /FALLBACK PROMPT/, 'another provider keeps its own prompt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a compaction on another model than the turn sends its own prompt: no tools, one mark, the same bytes every call', async () => {
  const { dir, sent, turn, compress } = await setup('anthropic', () => compactorPrompt({}));
  try {
    const payload = cachePayload(fixture()) as Payload;
    // The fixture turn ran on claude-opus-5-5; the compactor is 'compactor' on the same provider.
    turn.capture('anthropic', payload);
    assert.equal(turn.captured, true);
    assert.equal(turn.matches('anthropic', 'compactor'), false);
    for (let k = 0; k < 3; k++)
      await compress({ context: view, source, merge: false, part: { l: 0, i: 1 + k } }, new AbortController().signal);
    for (const request of sent) {
      assert.equal(request.tools, undefined, 'no tool definitions');
      assert.deepEqual(request.system, [{ type: 'text', text: compactorPrompt({}), cache_control: { type: 'ephemeral' } }]);
    }
    assert.equal(new Set(sent.map(r => JSON.stringify(r.system))).size, 1, 'stable across calls');
    const own = compactorPrompt({});
    assert.ok(own.includes(COMPACTIONS));
    assert.doesNotMatch(own, /Tools:|zoom\(id|search_memory|# Turns|<skill|available_skills/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a turn on the compactor’s model is reused only while its prompt holds the compaction rules', async () => {
  const { dir, sent, turn, compress } = await setup('anthropic', () => compactorPrompt({}));
  try {
    const turnPayload = (rules: boolean) => {
      const payload = cachePayload(fixture()) as Payload;
      payload.system = [{ type: 'text', text: sharedPrompt(false, {}, rules) }];
      return payload;
    };
    turn.capture('anthropic', turnPayload(true), 'compactor');
    assert.equal(turn.matches('anthropic', 'compactor'), true);
    await compress({ context: view, source, merge: false }, new AbortController().signal);
    assert.ok(sent[0].tools, 'the turn’s tools, byte for byte');
    assert.match(JSON.stringify(sent[0].system), /# Turns/);
    // A turn sent while the compactor was on another model has no rules: a compaction must not borrow it.
    turn.capture('anthropic', turnPayload(false), 'compactor');
    assert.equal(turn.matches('anthropic', 'compactor'), false);
    await compress({ context: view, source, merge: false }, new AbortController().signal);
    assert.equal(sent[1].tools, undefined);
    assert.equal((sent[1].system as { text: string }[])[0].text, compactorPrompt({}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the compaction view: 16-32 KB of id+n| lines, never finer than the chat view, ending at the node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cview-'));
  const contexts: { part: { l: number; i: number }; context: string }[] = [];
  const memory = new Memory(
    dir,
    async input => {
      contexts.push({ part: input.part!, context: input.context });
      return `summary ${contexts.length} `.padEnd(400, 'q');
    },
    () => {},
    40_000,
  );
  try {
    for (let i = 0; i < 300; i++) {
      memory.append(i % 2 ? 'talk' : 'user', `message ${i} `.padEnd(900, 'y'));
      if (i % 3 === 2) await memory.settle(AbortSignal.timeout(5000));
    }
    await memory.settle(AbortSignal.timeout(10_000), true);
    const cview = memory.compactionParts;
    for (const p of memory.view)
      assert.ok(
        cview.some(c => start(c) <= start(p) && end(c) >= end(p)),
        'never finer than the chat view',
      );
    const bytes = memory.compactionView({ l: 0, i: memory.root.length }).length;
    assert.ok(bytes <= 10_000 + 2000, `${bytes} bytes against a 10,000-byte trigger`);
    for (const { part, context } of contexts) {
      assert.doesNotMatch(context, /not summarized yet/);
      const lines = context.split('\n').slice(1, -1).filter(Boolean);
      for (const line of lines) assert.match(line, /^\d+\+\d+\|/);
      const last = lines.at(-1)?.match(/^(\d+)\+(\d+)\|/);
      if (last) assert.ok(Number(last[1]) + Number(last[2]) <= (part.l ? end(part) : start(part)), 'the view ends at the node');
    }
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in a simulated chat, compactions and turns read most of their input from the cache', { timeout: 120_000 }, async () => {
  const { dir, sent, turn, compress } = await setup();
  const memoryDir = join(dir, 'memory');
  const turns = new CacheModel(),
    compactions = new CacheModel();
  let seen = 0;
  const memory = new Memory(memoryDir, async (input, signal) => {
    const line = await compress(input, signal);
    for (; seen < sent.length; seen++) compactions.request(sent[seen]);
    return line;
  });
  try {
    for (let i = 0; i < 1500; i++) {
      memory.append(i % 2 ? 'talk' : 'user', `message ${i} `.padEnd(1200, 'y'));
      if (i % 3 !== 2) continue;
      await memory.settle(AbortSignal.timeout(10_000));
      const payload = fixture();
      payload.messages[0].content[0].text = memory.render();
      payload.messages[0].content[1].text = `question ${i}`;
      const marked = cachePayload(payload);
      turn.capture('anthropic', marked);
      turns.request(marked);
    }
    await memory.settle(AbortSignal.timeout(30_000), true);
    console.log(
      `turn cache read ratio ${(turns.ratio * 100).toFixed(1)} %, compaction cache read ratio ${(compactions.ratio * 100).toFixed(1)} % over ${sent.length} compactions`,
    );
    assert.ok(turns.ratio > 0.9, `turns ${turns.ratio}`);
    assert.ok(compactions.ratio > 0.8, `compactions ${compactions.ratio}`);
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
