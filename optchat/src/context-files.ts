import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The file names pi tries for its global context file in the agent dir. */
const GLOBAL_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Drop the user's global context files (pi's agent-dir AGENTS.md and ~/.agents/AGENTS.md) so they never reach a
 * bot; the profile AGENTS.md replaces them. Project files from cwd and its parents stay. Matches by path and by
 * resolved real path, so a symlinked global file is caught whichever side pi reports.
 */
export function withoutGlobalContext<T extends { path: string }>(files: T[], agentDir: string, home = homedir()): T[] {
  const blocked = new Set<string>();
  for (const path of [...GLOBAL_NAMES.map(name => join(agentDir, name)), join(home, '.agents', 'AGENTS.md')]) {
    blocked.add(resolve(path));
    const target = real(path);
    if (target) blocked.add(target);
  }
  return files.filter(file => {
    if (blocked.has(resolve(file.path))) return false;
    const target = real(file.path);
    return !(target && blocked.has(target));
  });
}
