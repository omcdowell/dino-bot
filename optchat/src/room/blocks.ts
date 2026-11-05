import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cap, ROOM_BLOCK, type Memory } from '../memory.ts';

/**
 * Room blocks (plan §3.6): group chat talk the paseo-bots plugin hands over to a bot's main memory. The plugin writes
 * one JSON file per block, by atomic rename, into `<profile>/memory/room-blocks/` and never takes the profile lock.
 * The bot appends each block to its log as a user message headed `[room <group> block <id> …]` (tagged
 * `room:<group>`), then removes the file, as it does with `resummarise/` requests. This folder sits in the profile,
 * not in a memory generation, so an import never strands a block.
 */
export const ROOM_BLOCKS = join('memory', 'room-blocks');
export const roomBlocksDir = (profileDir: string) => join(profileDir, ROOM_BLOCKS);
/** The log entry's receipt: a block is applied once, whatever happens to its file. */
export const blockReceipt = (id: string) => `room-block:${id}`;

export interface RoomBlock {
  id: string;
  group: string;
  /** ISO time of its first and last room line. */
  from: string;
  to: string;
  text: string;
}

function parse(value: unknown): RoomBlock {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  const { id, group, from, to, text } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof group !== 'string' || typeof from !== 'string' || typeof to !== 'string' || typeof text !== 'string')
    throw new Error('missing id, group, from, to or text');
  const header = ROOM_BLOCK.exec(text);
  if (!header || header[1] !== group || header[2] !== id) throw new Error('text is not headed [room <group> block <id> msgs …]');
  return { id, group, from, to, text };
}

/**
 * Appends every waiting block to `memory`, oldest first, and removes its file. A block whose receipt is already in
 * the log (the bot stopped after appending it, or the plugin wrote it twice) is only removed. A file that is not a
 * block is renamed `<name>.bad` and reported, so it is not read again. Returns how many blocks were appended.
 * Call only between runs: before a turn renders its view, or after a run settles.
 */
export function applyRoomBlocks(memory: Memory, profileDir: string, warn: (s: string) => void): number {
  const dir = roomBlocksDir(profileDir);
  if (!existsSync(dir)) return 0;
  const blocks: { path: string; block: RoomBlock }[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const path = join(dir, name);
    try {
      blocks.push({ path, block: parse(JSON.parse(readFileSync(path, 'utf8'))) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      warn(`Skipped room block ${name}: ${error instanceof Error ? error.message : String(error)}`);
      renameSync(path, `${path}.bad`);
    }
  }
  if (!blocks.length) return 0;
  blocks.sort((a, b) => a.block.to.localeCompare(b.block.to) || a.block.id.localeCompare(b.block.id));
  const receipts = new Set(memory.root.map(e => e.receipt).filter(Boolean));
  let applied = 0;
  for (const { path, block } of blocks) {
    const receipt = blockReceipt(block.id);
    if (!receipts.has(receipt)) {
      memory.append('user', cap(block.text), new Date().toISOString(), receipt);
      receipts.add(receipt);
      applied++;
    }
    rmSync(path, { force: true });
  }
  return applied;
}
