import { createHash } from 'node:crypto';

type Block = Record<string, unknown>;
const record = (v: unknown): v is Block => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A model of Anthropic's prompt cache, counted in bytes: entries are stored only at marks (blocks with cache_control,
 * and the last block for a top-level mark), and a request reads the longest stored prefix that ends at most 20 blocks
 * before one of its marks. Entries never expire here.
 */
export class CacheModel {
  private readonly entries = new Set<string>();
  read = 0;
  written = 0;
  uncached = 0;
  request(payload: unknown) {
    if (!record(payload) || !Array.isArray(payload.messages)) throw new Error('not a payload');
    const blocks: { key: string; bytes: number; mark: boolean }[] = [];
    const add = (where: string, block: unknown) => {
      const { cache_control, ...rest } = record(block) ? block : { text: String(block) };
      const json = JSON.stringify(rest);
      blocks.push({ key: `${where}:${json}`, bytes: Buffer.byteLength(json), mark: !!cache_control });
    };
    for (const tool of Array.isArray(payload.tools) ? payload.tools : []) add('tool', tool);
    for (const block of Array.isArray(payload.system) ? payload.system : payload.system ? [payload.system] : []) add('system', block);
    for (const message of payload.messages)
      if (record(message) && Array.isArray(message.content)) for (const block of message.content) add(String(message.role), block);
    if (payload.cache_control && blocks.length) blocks.at(-1)!.mark = true;
    const hashes: string[] = [];
    let hash = createHash('sha256');
    for (const block of blocks) {
      hash.update(block.key);
      hashes.push(hash.copy().digest('hex'));
    }
    const marks = blocks.flatMap((b, j) => (b.mark ? [j] : []));
    let hit = -1;
    for (const m of marks) for (let j = m; j >= Math.max(0, m - 19); j--) if (j > hit && this.entries.has(hashes[j])) hit = j;
    const sum = (from: number, to: number) => blocks.slice(from, to).reduce((n, b) => n + b.bytes, 0);
    const last = marks.length ? marks.at(-1)! : -1;
    const read = sum(0, hit + 1),
      written = last > hit ? sum(hit + 1, last + 1) : 0;
    this.read += read;
    this.written += written;
    this.uncached += sum(Math.max(hit, last) + 1, blocks.length);
    for (const m of marks) this.entries.add(hashes[m]);
    return { read, written };
  }
  get ratio() {
    return this.read / (this.read + this.written + this.uncached);
  }
}
