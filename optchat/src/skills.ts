import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';
import { dataHome } from './profiles.ts';

/**
 * Which skills a profile's prompt lists. Every profile shares one list:
 *
 *   "skills": {
 *     "global": ["herdr", "diagnose"],          // the user's global skills (~/.pi/agent/skills, ~/.agents/skills) to keep
 *     "hide": ["an-old-skill"]                  // any skill to leave out, a bot's own .agents/skills included
 *   }
 *
 * The shared list is `<OPTCHAT_HOME>/skills.json` when that file has the key, else DEFAULT_SKILLS (herdr and the bundled workers skill). A
 * profile's config.json `skills` key overrides it, key by key, for that profile alone. A listed name that is not
 * installed is simply not listed. Every skill of a bot's own folder and of its packages is listed unless hidden.
 * Read on every turn, so an edit applies on the next message without a restart. Nothing is deleted: a left-out skill
 * is only not listed in the prompt.
 */
export interface SkillPolicy {
  global: string[];
  hide: string[];
}

/** For a bot, herdr (and the bundled `workers` skill) is how it runs workers; the user's other global skills are for interactive sessions. */
export const DEFAULT_SKILLS: SkillPolicy = { global: ['herdr', 'workers'], hide: [] };
export const SHARED_SKILLS_FILE = 'skills.json';

const names = (value: unknown[]) => value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean);

/** The keys a file sets, as `{ global?, hide? }`; nothing for a missing or bad file or a key that is not a list. */
function readPolicy(file: string, nested: boolean): Partial<SkillPolicy> {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    const raw = (nested ? value?.skills : value) as { global?: unknown; hide?: unknown } | null | undefined;
    const out: Partial<SkillPolicy> = {};
    if (Array.isArray(raw?.global)) out.global = names(raw.global);
    if (Array.isArray(raw?.hide)) out.hide = names(raw.hide);
    return out;
  } catch {
    return {};
  }
}

export function skillPolicy(dir: string, home: string = dataHome()): SkillPolicy {
  const shared = { ...DEFAULT_SKILLS, ...readPolicy(join(home, SHARED_SKILLS_FILE), false) };
  return { ...shared, ...readPolicy(join(dir, 'config.json'), true) };
}

/** A skill from the user's global skill folders (pi's agent dir, ~/.agents/skills), not from a package or the bot. */
const isGlobal = (skill: Skill) => skill.sourceInfo?.scope === 'user' && skill.sourceInfo.origin === 'top-level';

export function allowedSkills(skills: Skill[], policy: SkillPolicy): Skill[] {
  return skills.filter(skill => !policy.hide.includes(skill.name) && (!isGlobal(skill) || policy.global.includes(skill.name)));
}
