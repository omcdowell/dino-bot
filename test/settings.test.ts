import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, defaults, loadConfig, profilePath, saveConfig, type ProfileConfig } from '../src/profiles.ts';
import { settingsPage } from '../src/settings-page.ts';
import { isCompaction } from './compaction-call.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
const model = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}
/** A provider whose first reply to a `hold …` task waits until the test releases it or the agent stops. */
async function fixture(dir: string, reply: (context: Context) => string = () => 'done') {
  const releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(dir, 'models.json'),
    refreshOnCreate: false,
  });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local',
    apiKey: 'synthetic',
    api: 'openai-completions',
    models: [
      {
        id: 'fixture',
        name: 'Fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
    streamSimple(m, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: reply(context) }],
        api: m.api,
        provider: m.provider,
        model: m.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        usage: emptyUsage(),
      };
      const task =
        textContent(context.messages.find(x => x.role === 'user')?.content)
          .split('Your task:\n')
          .at(-1) ?? '';
      void (async () => {
        if (task.startsWith('hold') && context.messages.filter(x => x.role === 'user').length === 1)
          await new Promise<void>(resolve => {
            releases.set(task, resolve);
            options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  return { runtime, releases };
}
test('a config.json from before settings existed loads with the defaults, and settings round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-config-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: defaults.compactor, subagent: defaults.subagent }));
    assert.deepEqual(loadConfig(dir), {
      ...defaults,
      previousExchange: true,
      previousExchangeKB: 16,
      toolDigest: false,
      summaryAcceptBytes: 640,
    });
    // Upstream's subagent keys are kept untouched, so upstream pi-optchat can still open the profile.
    const changed = {
      ...loadConfig(dir),
      subagentLevels: 3,
      maxAgents: 12,
      previousExchange: false,
      previousExchangeKB: 4,
      toolDigest: true,
      summaryAcceptBytes: 512,
    };
    saveConfig(dir, changed);
    assert.deepEqual(loadConfig(dir), changed);
    for (const [key, value] of [
      ['previousExchangeKB', 1.5],
      ['previousExchange', 'yes'],
      ['toolDigest', 'no'],
      ['summaryAcceptBytes', 511],
      ['previousExchangeKB', null],
    ] as const) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...changed, [key]: value }));
      assert.throws(() => loadConfig(dir), /Invalid profile config/, `${key}: ${value}`);
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ previousExchange: true }));
    assert.throws(() => loadConfig(dir), /Invalid profile config/, 'a compactor model is required');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the previous exchange can be turned off, and its size limit is the profile's", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-previous-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const turns: Context[] = [];
  const { runtime } = await fixture(dir, context => {
    if (isCompaction(context)) return 'summary';
    turns.push(structuredClone(context));
    const asked = textContent(context.messages.at(-1)?.content).split('</chat>').at(-1)?.trim() ?? '';
    return asked === 'Long answer please.' ? 'x'.repeat(3000) : `Answer to: ${asked}`;
  });
  const profile = profilePath('fixture');
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const open = async (config: Partial<ProfileConfig>) => {
    saveConfig(profile, { ...loadConfig(profile), compactor: model, ...config });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, 'agent'),
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [optchat],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (
      await createAgentSession({
        modelRuntime: runtime,
        model: runtime.getModel('fixture', 'fixture'),
        resourceLoader: loader,
        settingsManager,
        sessionManager: manager,
        tools: ['zoom'],
      })
    ).session;
    await session.bindExtensions({});
    return session;
  };
  const close = async () => {
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    session = undefined;
  };
  const messages = (turn: Context) => turn.messages.filter(m => m.role !== 'system').map(m => m.role);
  const continuity = (turn: Context) =>
    /immediately preceding completed\s+exchange/.test(textContent(turn.messages.find(m => m.role === 'system')?.content));
  try {
    createProfile('fixture');
    let s = await open({ previousExchange: false });
    await s.prompt('First.');
    await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user'], 'off: the follow-up sees the memory view only');
    assert.ok(!continuity(turns.at(-1)!), 'off: the prompt does not mention a replayed exchange');
    await close();
    s = await open({ previousExchange: true, previousExchangeKB: 2 });
    await s.prompt('Short answer please.');
    await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user', 'assistant', 'user']);
    assert.ok(continuity(turns.at(-1)!));
    await s.prompt('Long answer please.');
    await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user'], 'a 3 KB exchange is over a 2 KB limit');
  } finally {
    await close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the settings page saves a valid number and explains an invalid one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-page-'));
  try {
    const config: ProfileConfig = { ...defaults, compactor: { provider: 'anthropic', model: 'claude-haiku-4-5', thinking: 'low' } };
    const page = settingsPage(
      plain,
      {
        profile: 'demo',
        config,
        models: [{ name: 'anthropic/claude-sonnet-5-5', thinking: ['low', 'medium'] }],
        save: next => saveConfig(dir, next),
      },
      () => {},
    );
    const type = (...keys: string[]) => {
      for (const key of keys) page.handleInput(key);
    };
    assert.match(page.render(100).join('\n'), /Previous exchange limit\s+16 KB  default\n/);
    assert.match(
      page.render(100).join('\n'),
      /claude-haiku-4-5 · low  default claude-sonnet-5-5 · medium/,
      'a changed model shows its default too',
    );
    assert.doesNotMatch(page.render(100).join('\n'), /Subagent/);
    type('\x1b[B', '\x1b[B', '\r'); // down to Previous exchange limit, open it
    type('0', '\r');
    assert.match(page.render(100).join('\n'), /must be a whole number of 1 or more/);
    type('\x7f', 'x', '\r');
    assert.match(page.render(100).join('\n'), /must be a whole number of 1 or more/);
    type('\x7f', '3', '\r');
    assert.equal(config.previousExchangeKB, 3);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).previousExchangeKB, 3);
    assert.match(page.render(100).join('\n'), /Previous exchange limit\s+3 KB  default 16 KB[\s\S]*Saved previous exchange limit 3 KB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the thinking step offers only levels the model takes, so Sonnet 5.5 has no "off" that would run at high effort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-page-'));
  try {
    const config: ProfileConfig = { ...defaults };
    const page = settingsPage(
      plain,
      {
        profile: 'demo',
        config,
        save: next => saveConfig(dir, next),
        models: [{ name: 'anthropic/claude-sonnet-5-5', thinking: ['low', 'medium', 'high'] }],
      },
      () => {},
    );
    page.handleInput('\r'); // open Compactor model
    page.handleInput('\r'); // pick the only model
    const step = page.render(100).join('\n');
    assert.match(step, /Thinking level[\s\S]*low[\s\S]*high/);
    assert.doesNotMatch(step, /^\W*(off|minimal)\s*$/m);
    page.handleInput('\x1b[A');
    page.handleInput('\r'); // up from the current "medium" to "low"
    assert.deepEqual(config.compactor, { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'low' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
