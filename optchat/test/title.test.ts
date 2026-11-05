import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { mainTitle, TabTitle } from '../src/title.ts';
import { isCompaction } from './compaction-call.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

const agentDir = (process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-')));
after(() => rmSync(agentDir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await sleep(10);
  }
}

test('tab titles show the profile and whether the agent is working', () => {
  assert.equal(mainTitle('personal', false), 'π personal');
  assert.equal(mainTitle('personal', true), '● π personal');
});

test('the last title is re-applied after Pi overwrites it, and a stale ctx is ignored', () => {
  const written: string[] = [];
  const title = new TabTitle();
  title.reapply();
  assert.equal(written.length, 0, 'nothing to restore before a title was set');
  title.show(t => written.push(t), 'π work');
  title.show(t => written.push(t), 'π work');
  assert.deepEqual(written, ['π work'], 'unchanged titles are not rewritten');
  title.reapply();
  assert.deepEqual(written, ['π work', 'π work']);
  title.show(() => {
    throw new Error('This extension ctx is stale');
  }, '● π work');
  title.reapply();
  title.clear();
  title.reapply();
  assert.deepEqual(written, ['π work', 'π work']);
});

test('the main window title follows the real Pi session: profile, working, and restored after renames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-title-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let notifyHeld!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => {
    notifyHeld = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({
      authPath: join(dir, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'),
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
      streamSimple(model, context) {
        const compression = isCompaction(context);
        const last = context.messages.at(-1);
        const text = textContent(last?.content);
        const reply: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: compression ? 'Summary.' : 'Done.' }],
          timestamp: Date.now(),
          stopReason: 'stop',
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
        };
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (!compression && text.endsWith('Long task.')) {
            stream.push({ type: 'start', partial: reply });
            notifyHeld();
            await released;
          }
          stream.push({ type: 'done', reason: 'stop', message: reply });
          stream.end();
        })();
        return stream;
      },
    });
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
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (
      await createAgentSession({
        modelRuntime: runtime,
        model: runtime.getModel('fixture', 'fixture'),
        resourceLoader: loader,
        settingsManager,
        sessionManager: manager,
        tools: ['zoom', 'date'],
      })
    ).session;
    const titles: string[] = [];
    const uiContext: ExtensionUIContext = {
      ...session.extensionRunner.getUIContext(),
      setTitle: title => {
        titles.push(title);
      },
    };
    await session.bindExtensions({ uiContext });

    assert.equal(titles[0], 'π fixture');
    await sleep(300); // Interactive Pi writes its own "π - <cwd>" title right after session_start; ours follows.
    assert.ok(titles.length >= 3 && titles.every((t): boolean => t === 'π fixture'), JSON.stringify(titles));

    const running = session.prompt('Long task.');
    await held;
    assert.equal(titles.at(-1), '● π fixture');
    release();
    await running;
    await session.agent.waitForIdle();
    await until(() => titles.at(-1) === 'π fixture');

    const before = titles.length;
    session.setSessionName('renamed'); // Pi retitles the tab on renames.
    await until(() => titles.length > before);
    assert.equal(titles.at(-1), 'π fixture');
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
