import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';
import { allowedSkills, DEFAULT_SKILLS, skillPolicy } from '../src/skills.ts';

const skill = (name: string, scope: 'user' | 'project' | 'temporary', origin: 'top-level' | 'package' = 'top-level') =>
  ({ name, description: name, filePath: `/x/${name}/SKILL.md`, baseDir: `/x/${name}`, disableModelInvocation: false, sourceInfo: { path: `/x/${name}`, source: 'auto', scope, origin } }) as Skill;
const all = [skill('herdr', 'user'), skill('cobrowse', 'user'), skill('diagnose', 'user'), skill('own', 'project'), skill('old-own', 'project'), skill('pkg', 'user', 'package'), skill('cli', 'temporary')];
const listed = (policy: { global: string[]; hide: string[] }, skills = all) => allowedSkills(skills, policy).map(s => s.name);

/** A data home with one profile; `shared` is written as skills.json, `profile` as the profile's config.json skills key. */
function home(shared?: unknown, profile?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'optchat-skills-'));
  const dir = join(root, 'profiles', 'bot');
  mkdirSync(dir, { recursive: true });
  if (shared !== undefined) writeFileSync(join(root, 'skills.json'), typeof shared === 'string' ? shared : JSON.stringify(shared));
  if (profile !== undefined) writeFileSync(join(dir, 'config.json'), typeof profile === 'string' ? profile : JSON.stringify({ skills: profile }));
  return { root, dir, policy: () => skillPolicy(dir, root), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the shipped default lists herdr and no other global skill; bot, package and --skill ones stay', () => {
  assert.deepEqual(DEFAULT_SKILLS, { global: ['herdr', 'workers'], hide: [] });
  assert.deepEqual(listed(DEFAULT_SKILLS), ['herdr', 'own', 'old-own', 'pkg', 'cli']);
});

test('with no shared file and no profile key, a profile gets the shipped default', () => {
  const h = home(undefined, {});
  try {
    assert.deepEqual(h.policy(), DEFAULT_SKILLS);
  } finally {
    h.done();
  }
});

test('the shared skills.json applies to every profile, herdr included', () => {
  const h = home({ global: ['herdr', 'diagnose', 'handoff'], hide: ['old-own'] });
  try {
    assert.deepEqual(h.policy(), { global: ['herdr', 'diagnose', 'handoff'], hide: ['old-own'] });
    assert.deepEqual(listed(h.policy()), ['herdr', 'diagnose', 'own', 'pkg', 'cli']);
  } finally {
    h.done();
  }
});

test('a listed skill that is not installed is skipped silently', () => {
  assert.deepEqual(listed({ global: ['herdr', 'not-installed'], hide: ['also-missing'] }), ['herdr', 'own', 'old-own', 'pkg', 'cli']);
  assert.deepEqual(listed({ global: ['herdr'], hide: [] }, [skill('own', 'project')]), ['own'], 'no herdr installed: nothing added');
});

test("a bot's own skills load, and hide drops any skill, its own included", () => {
  assert.deepEqual(listed({ global: [], hide: [] }), ['own', 'old-own', 'pkg', 'cli']);
  assert.deepEqual(listed({ global: ['herdr'], hide: ['old-own', 'herdr'] }), ['own', 'pkg', 'cli']);
});

test('a profile key overrides the shared list key by key', () => {
  const h = home({ global: ['herdr', 'diagnose'], hide: ['old-own'] }, { global: ['cobrowse'] });
  try {
    assert.deepEqual(h.policy(), { global: ['cobrowse'], hide: ['old-own'] });
  } finally {
    h.done();
  }
});

test('bad entries are dropped; a bad file or a non-list key falls back to the level below', () => {
  const h = home({ global: ['herdr', 3, ' diagnose ', ''], hide: 'x' }, '{');
  try {
    assert.deepEqual(h.policy(), { global: ['herdr', 'diagnose'], hide: [] });
    writeFileSync(join(h.root, 'skills.json'), '{');
    assert.deepEqual(h.policy(), DEFAULT_SKILLS);
  } finally {
    h.done();
  }
});
