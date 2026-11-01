import { isView } from './memory.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lines per cache block. Anthropic looks back up to 20 blocks from a mark, so a turn finds the last one's mark across 80 new lines. */
export const BLOCK_LINES = 4;

/**
 * The view as blocks of BLOCK_LINES lines, byte for byte: `<chat>` goes with the first block, and the lines after the
 * last whole block go with `</chat>` in a final block. `whole` counts the whole blocks; the last of them carries the mark.
 */
export function viewBlocks(text: string) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];
  if (lines.length < 2) return { blocks: [text], whole: 0 };
  const body = lines.slice(1, -1),
    blocks: string[] = [];
  for (let j = 0; j + BLOCK_LINES <= body.length; j += BLOCK_LINES) blocks.push(body.slice(j, j + BLOCK_LINES).join(''));
  const whole = blocks.length;
  let rest = body.slice(whole * BLOCK_LINES).join('') + lines.at(-1);
  if (whole) blocks[0] = lines[0] + blocks[0];
  else rest = lines[0] + rest;
  blocks.push(rest);
  return { blocks, whole };
}

/** The part of a view that a mark caches: every whole block, or nothing if there is none. */
export function markedPrefix(text: string) {
  const { blocks, whole } = viewBlocks(text);
  return blocks.slice(0, whole).join('');
}

const EPHEMERAL = { type: 'ephemeral' };

/**
 * Anthropic, at most 4 marks: one on the system prompt (with the tools before it, the same for every call), one on the
 * view's last whole 4-line block, and the automatic one at the end of the request. Pi's own marks are removed.
 */
export function cachePayload(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex(
      (block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text),
    );
    if (at < 0) continue;
    const { blocks: pieces, whole } = viewBlocks(message.content[at].text);
    const blocks = pieces.map((text, j) => ({
      type: 'text',
      text,
      ...(j === whole - 1 ? { cache_control: { ...EPHEMERAL } } : {}),
    }));
    message.content.splice(at, 1, ...blocks);
    for (const block of blocks) view.add(block);
    break;
  }
  if (!view.size) return payload;
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  const system: unknown = Array.isArray(payload.system) ? payload.system.at(-1) : undefined;
  if (record(system)) system.cache_control = { ...EPHEMERAL };
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content)) for (const item of message.content) if (record(item) && !view.has(item)) delete item.cache_control;
  }
  payload.cache_control = { ...EPHEMERAL };
  return payload;
}

/**
 * The tools and system prompt of the last OptChat turn sent to Anthropic, kept byte for byte so compactions send the
 * same ones (UniiChat §4) and share their cache prefix. Until a turn has been sent, compactions use their own prompt.
 */
export class TurnPrefix {
  private value?: { provider: string; system?: string; tools?: string; key: string };
  /** Keeps `payload`'s system prompt and tools if it is a turn: a request whose first user message holds the view. */
  capture(provider: string, payload: unknown) {
    if (!record(payload) || !Array.isArray(payload.messages)) return;
    const first: unknown = payload.messages.find(m => record(m) && m.role === 'user');
    if (!record(first) || !Array.isArray(first.content)) return;
    const head: unknown = first.content[0];
    if (!record(head) || typeof head.text !== 'string' || !isView(head.text)) return;
    const system = payload.system === undefined ? undefined : JSON.stringify(payload.system),
      tools = payload.tools === undefined ? undefined : JSON.stringify(payload.tools);
    this.value = { provider, system, tools, key: `${provider}\n${system ?? ''}\n${tools ?? ''}` };
  }
  get captured() {
    return !!this.value;
  }
  /** Identifies the shared prefix, for calls that wait on each other's cache writes. */
  get key() {
    return this.value?.key ?? '';
  }
  /** Puts the turn's system prompt and tools into a compaction's payload for the same provider. Returns whether it did. */
  apply(provider: string, payload: unknown) {
    const value = this.value;
    if (!value || value.provider !== provider || !record(payload)) return false;
    if (value.system === undefined) delete payload.system;
    else payload.system = JSON.parse(value.system);
    if (value.tools === undefined) delete payload.tools;
    else payload.tools = JSON.parse(value.tools);
    return true;
  }
}
