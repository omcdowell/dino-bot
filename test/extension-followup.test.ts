import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { records } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { buildContext, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

const agentDir = (process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-')));
after(() => rmSync(agentDir, { recursive: true, force: true }));

/** pi-web-access's follow-up after a web search's background fetch (its index.ts, startBackgroundFetch). */
const READY = {
  customType: 'web-search-content-ready',
  content: 'Content fetched for 3/3 URLs [f1]. Full page content now available.',
  display: true,
};

test('buildContext: an extension message that starts a run is its input and carries the view', () => {
  const custom = { role: 'custom' as const, ...READY, timestamp: 1 };
  const context = buildContext([], [custom], '<chat>\nsummary\n</chat>', 'instructions');
  assert.deepEqual(
    context.map(m => m.role),
    ['system', 'custom'],
  );
  const text = textContent((context[1] as { content: unknown }).content);
  assert.match(text, /^<chat>\nsummary\n<\/chat>\nContent fetched for 3\/3 URLs/);
  assert.equal(custom.content, READY.content, 'the saved message is not mutated');
  assert.throws(() => buildContext([], [], 'view', 'prompt'), /no current user message/);
});

test("pi-web-access's 'Content fetched' follow-up after a reply is a turn of its own, not an aborted run", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-followup-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('wallace');
    const profile = profilePath('wallace');
    saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const calls: Context[] = [];
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
        calls.push(structuredClone(context));
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: calls.length === 1 ? 'Here is what I found.' : 'The full pages add one detail.' }],
          timestamp: Date.now(),
          stopReason: 'stop',
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end();
        });
        return stream;
      },
    });
    let web: ExtensionAPI | undefined;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, 'agent'),
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [optchat, pi => void (web = pi)],
    });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'wallace' });
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
    const errors: string[] = [];
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: (text, type) => {
          if (type === 'error') errors.push(text);
        },
      },
      mode: 'rpc',
    });
    await session.prompt('Search the web for the launch date.');
    await session.agent.waitForIdle();
    assert.equal(calls.length, 1);
    // The background fetch finishes after the reply, while the bot is idle: a run with no user message.
    web!.sendMessage(READY, { triggerTurn: true });
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await session.agent.waitForIdle();
    assert.deepEqual(errors, [], 'no "has no current user message" and no abort');
    assert.equal(calls.length, 2, 'the follow-up got a turn');
    // Pi gives the model the extension message as a user message; the view leads the context as usual (here on the
    // replayed previous exchange), and the earlier question and answer come before the follow-up.
    const sent = calls[1].messages.filter(m => (m.role as string) !== 'system').map(m => [m.role, textContent(m.content as never)]);
    assert.deepEqual(
      sent.map(([role]) => role),
      ['user', 'assistant', 'user'],
    );
    assert.match(sent[0][1], /^<chat>[\s\S]*Search the web for the launch date\.$/);
    assert.equal(sent[2][1], READY.content);
    const replies = session.messages.filter(m => m.role === 'assistant');
    assert.deepEqual(
      replies.map(m => (m as AssistantMessage).stopReason),
      ['stop', 'stop'],
    );
    // Memory: the follow-up is an echo before the reply it prompted.
    const log = records(join(profile, 'main'), () => {}) as { kind: string; text: string }[];
    assert.deepEqual(
      log.map(e => e.kind),
      ['user', 'talk', 'echo', 'talk'],
    );
    assert.match(log[2].text, /^web-search-content-ready: Content fetched for 3\/3 URLs/);
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
