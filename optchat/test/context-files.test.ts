import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectContextFiles, type BeforeAgentStartEvent, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
// Pi's own prompt renderer, as used by the extension runner for event.systemPrompt and the run's prompt.
import {
  buildSystemPrompt,
  normalizeBuildSystemPromptOptions,
} from '../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import { withoutGlobalContext } from '../src/context-files.ts';
import { SessionController, type OpenProfile } from '../src/controller.ts';

/** A fake home: a pi agent dir whose AGENTS.md is a symlink, ~/.agents/AGENTS.md, a project and a profile. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'optchat-context-'));
  const home = join(root, 'home');
  const agentDir = join(home, '.pi', 'agent');
  const deployed = join(home, '.agents', 'deploy', 'tree', '.pi', 'agent');
  const project = join(home, 'code', 'project');
  const profile = join(root, 'profile');
  for (const dir of [agentDir, deployed, project, profile]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(deployed, 'AGENTS.md'), '# Global Pi Instructions\nGLOBAL_PI_MARKER\n');
  symlinkSync(join(deployed, 'AGENTS.md'), join(agentDir, 'AGENTS.md'));
  writeFileSync(join(home, '.agents', 'AGENTS.md'), 'SHARED_AGENTS_MARKER\n');
  writeFileSync(join(project, 'AGENTS.md'), 'PROJECT_MARKER\n');
  writeFileSync(join(profile, 'AGENTS.md'), 'PROFILE_MARKER\n');
  return { home, agentDir, deployed, project, profile };
}

test('the agent-dir AGENTS.md is dropped, by its own path and by its symlink target', () => {
  const w = world();
  const viaLink = { path: join(w.agentDir, 'AGENTS.md'), content: '' };
  const viaTarget = { path: join(w.deployed, 'AGENTS.md'), content: '' };
  assert.deepEqual(withoutGlobalContext([viaLink, viaTarget], w.agentDir, w.home), []);
});

test('~/.agents/AGENTS.md is dropped, the project AGENTS.md is kept', () => {
  const w = world();
  const shared = { path: join(w.home, '.agents', 'AGENTS.md'), content: '' };
  const project = { path: join(w.project, 'AGENTS.md'), content: '' };
  assert.deepEqual(withoutGlobalContext([shared, project], w.agentDir, w.home), [project]);
});

test('a project file that is a symlink to a global file is dropped too', () => {
  const w = world();
  symlinkSync(join(w.home, '.agents', 'AGENTS.md'), join(w.project, 'CLAUDE.md'));
  const linked = { path: join(w.project, 'CLAUDE.md'), content: '' };
  assert.deepEqual(withoutGlobalContext([linked], w.agentDir, w.home), []);
});

test('pi files under ~/.agents are filtered when cwd is inside ~/.agents', () => {
  const w = world();
  const files = loadProjectContextFiles({ cwd: join(w.home, '.agents'), agentDir: w.agentDir });
  assert.ok(files.some(f => f.path === join(w.home, '.agents', 'AGENTS.md')));
  assert.deepEqual(withoutGlobalContext(files, w.agentDir, w.home), []);
});

test('beforeAgentStart: the rendered prompt has the project and profile files but no global ones', () => {
  const w = world();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = w.agentDir;
  process.env.HOME = w.home;
  try {
    const contextFiles = loadProjectContextFiles({ cwd: w.project, agentDir: w.agentDir });
    assert.ok(
      contextFiles.some(f => f.content.includes('GLOBAL_PI_MARKER')),
      'pi loads the global file to begin with',
    );
    const options = normalizeBuildSystemPromptOptions({ cwd: w.project, contextFiles });
    const event = {
      type: 'before_agent_start',
      prompt: 'hi',
      get systemPrompt() {
        return buildSystemPrompt(options);
      },
      systemPromptOptions: options,
    } as BeforeAgentStartEvent;
    const pi = { appendEntry() {} } as unknown as ExtensionAPI;
    const controller = new SessionController(pi);
    controller.active = { name: 'test', dir: w.profile, config: { previousExchange: false } } as unknown as OpenProfile;
    controller.beforeAgentStart(event, {} as never);

    const prompt = buildSystemPrompt(options);
    assert.equal(prompt, event.systemPrompt);
    assert.doesNotMatch(prompt, /GLOBAL_PI_MARKER|Global Pi Instructions|SHARED_AGENTS_MARKER/);
    assert.match(prompt, /PROJECT_MARKER/);
    assert.match(prompt, /PROFILE_MARKER/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    process.env.HOME = previousHome;
  }
});
