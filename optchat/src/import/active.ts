import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where a profile's active memory lives (an import's generation, or the profile itself). Apart from job.ts so a host
 * that only needs this (the bots plugin's Claude Code engine) does not type-check the whole import pipeline.
 */
export function generationPath(dir: string, name: string) {
  if (name !== '.' && !/^memories\/[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid memory generation path.');
  return join(dir, name);
}
export function memoryDirectory(dir: string): string {
  const file = join(dir, 'active-memory.json');
  if (!existsSync(file)) return dir;
  const name: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof name !== 'string') throw new Error('Invalid active memory pointer.');
  const path = generationPath(dir, name);
  if (!existsSync(join(path, 'main'))) throw new Error('Active memory generation is missing.');
  return path;
}
