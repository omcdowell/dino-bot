import { clampThinkingLevel, type Api, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { compactorPrompt } from './prompts.ts';
import { bytes, end, name, NODE, start, type Compression, type Compressor } from './memory.ts';
import { cachePayload, markedPrefix, TurnPrefix } from './cache.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { CompactorError, parseFailure, retryAfterMs, type ProviderFailure } from './provider-error.ts';

export interface ModelChoice {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}
/** A level the model can't take would be sent as no level, which Sonnet 5.5 runs at high effort; Pi's own sessions clamp the same way. */
export const reasoningFor = (model: Model<Api>, level: ThinkingLevel) => {
  const thinking = clampThinkingLevel(model, level);
  return thinking === 'off' ? undefined : thinking;
};
/** A realistic summary line of exactly NODE bytes, on a topic no real chat shares so its wording can't leak into summaries. */
export const SCALE =
  'user: Plan the Lisbon trip for 14-18 May: four adults, one in a wheelchair, 2400 EUR budget, no flights before 09:00. talk: Suggested Baixa; skip tram 28 (not step-free). tool: searched TAP, easyJet fares; echo: TAP TP1205 at 08:40 (too early), easyJet U27652 at 11:15 is 162 EUR each. user: "Book easyJet; step-free rooms matter more than a view." work: [4c1e9a20] Casa do Rio has two step-free rooms at 138 EUR/night, free cancellation to 10 May, held to 2 May. talk: Asked about a Sintra day trip, unanswered.';
/** The task after a compaction's view (UniiChat §4), with ids and <input>. The ruler is still the sample line. */
export function task(input: Compression) {
  const part = input.part,
    size = `of at most ${NODE} bytes (about 70 words), the length of this ruler, a made-up line whose words never belong in yours:\n${SCALE}`,
    historical = input.historical ? `\n${IMPORT_GUIDANCE}` : '';
  if (!input.merge)
    return `Compaction: compress ${part ? `message ${start(part)}` : 'the message'} into one line ${size}\n<input>\n${input.source}\n</input>${historical}`;
  const halves = part ? [0, 1].map(k => ({ l: part.l - 1, i: 2 * part.i + k })) : undefined;
  const [a, b] = halves ? halves.map(name) : ['a', 'b'];
  const lines = input.source.split('\n');
  const inputLines = halves && lines.length === 2 ? lines.map((line, k) => `${name(halves[k])}|${line}`).join('\n') : input.source;
  const detail = part
    ? `\n<chat> may hold their messages, ${start(part)} to ${end(part) - 1}, in more detail: take details of them from there too.`
    : '';
  return `Compaction: merge lines ${a} and ${b}, adjacent, into one line ${size}${detail}\n<input>\n${inputLines}\n</input>${historical}`;
}
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until it answers. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    for (let state = warm.get(prefix); state !== undefined; state = warm.get(prefix)) {
      if (typeof state === 'number') {
        if (Date.now() - state < WARM_MS) break;
        warm.delete(prefix);
        continue;
      }
      // A cancelled waiter leaves at once instead of waiting for someone else's primer.
      signal.throwIfAborted();
      let wake = () => {};
      const aborted = new Promise<void>(resolve => {
        wake = resolve;
      });
      signal.addEventListener('abort', wake, { once: true });
      await Promise.race([state, aborted]);
      signal.removeEventListener('abort', wake);
      signal.throwIfAborted();
    }
    let release = () => {};
    const pending = warm.has(prefix)
      ? undefined
      : new Promise<void>(resolve => {
          release = resolve;
        });
    if (pending) warm.set(prefix, pending);
    return (ok: boolean) => {
      if (ok) {
        for (const [k, at] of warm) if (typeof at === 'number' && Date.now() - at >= WARM_MS) warm.delete(k);
        warm.set(prefix, Date.now());
      } else if (warm.get(prefix) === pending) warm.delete(prefix);
      release();
    };
  };
}
/**
 * The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance).
 * On Anthropic, a compaction on the last turn's provider and model sends that turn's system prompt and tools byte for byte
 * (`turn`), so it shares their cache entry. Any other compaction (another model, whose cache the turn can't share, or no
 * turn yet) sends `own`, the compaction-only prompt: no tools, cached across the compactor's own calls.
 */
export function createCompressor(
  registry: ModelRegistry,
  choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {},
  accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes,
  turn = new TurnPrefix(),
  own = () => compactorPrompt(),
): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const selected = choice();
    const model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    const thinking = reasoningFor(model, selected.thinking);
    const step = task(input);
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: input.context },
          { type: 'text', text: step },
        ],
        timestamp: Date.now(),
      },
    ];
    const marked = markedPrefix(input.context);
    const anthropic = model.api === 'anthropic-messages';
    const shared = anthropic && turn.matches(model.provider, model.id),
      system = own();
    const prefix =
      anthropic && marked ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${shared ? turn.key : system}\n${marked}` : undefined;
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      // The SDKs drop a failed response's headers, so a wrapped fetch keeps its status and Retry-After.
      const seen: ProviderFailure = {};
      const fetch: typeof globalThis.fetch = async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (!response.ok) Object.assign(seen, { status: response.status, retryAfterMs: retryAfterMs(response.headers) });
        return response;
      };
      let reply: AssistantMessage;
      try {
        const stream = registry.streamSimple(
          model,
          { systemPrompt: system, messages },
          {
            reasoning: thinking,
            signal,
            cacheRetention: 'short',
            ...(anthropic ? { fetch } : {}),
            onPayload: payload => {
              if (!anthropic) return payload;
              if (shared) turn.apply(model.provider, model.id, payload);
              return cachePayload(payload);
            },
          },
        );
        // The cache entry is usable once the model starts answering.
        for await (const event of stream)
          if (event.type !== 'start') {
            warmed(event.type !== 'error');
            break;
          }
        reply = await stream.result();
      } finally {
        warmed(false);
      }
      onUsage(reply);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
        const message = reply.errorMessage ?? `Compactor ${reply.stopReason}`,
          parsed = parseFailure(message);
        throw new CompactorError(message, seen.status ?? parsed.status, seen.retryAfterMs ?? parsed.retryAfterMs);
      }
      const line = reply.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('')
        .trim()
        .replace(/^\d+\+\d+\|\s*/, '');
      // The turn's tools are sent but never meant to be called; a call that only calls one is tried again.
      if (!line && reply.content.some(c => c.type === 'toolCall')) continue;
      if (!line) throw new Error('Compactor returned no text.');
      tries.push(line);
      // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces.
      if (bytes(line) <= accepted() && bytes(line) < bytes(input.source)) break;
      messages.push(reply);
      const cut = Buffer.from(line)
        .subarray(0, NODE)
        .toString('utf8')
        .replace(/\uFFFD$/, '');
      messages.push({
        role: 'user',
        content: `Too long: your line is ${bytes(line)} bytes, over the ${NODE}-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\n${cut}| ← LIMIT`,
        timestamp: Date.now(),
      });
    }
    if (!tries.length) throw new Error('Compactor called tools instead of writing the line.');
    return tries.reduce((a, b) => (bytes(a) <= bytes(b) ? a : b));
  };
}
