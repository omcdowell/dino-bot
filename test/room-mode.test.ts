import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { Memory, type Compression } from '../src/memory.ts';
import { profilePath } from '../src/profiles.ts';
import { MASTER } from '../src/prompts.ts';
import { roomEnv, roomHistory } from '../src/room/index.ts';
import { ROOM_TOOLS, roomPrompt } from '../src/room/prompt.ts';
import { ROOM_LOOKUP_TOOLS } from '../src/room/tools.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

const agentDir = (process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-')));
after(() => rmSync(agentDir, { recursive: true, force: true }));

function snapshot(dir: string) {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex') + ':' + statSync(path).mtimeMs;
    }
  };
  walk(dir);
  return files;
}
const line = (id: string, from: string, text: string, minute = 40) =>
  JSON.stringify({
    v: 1,
    id,
    ts: `2026-10-13T16:${String(minute).padStart(2, '0')}:00.000Z`,
    group: 'alarm-clock',
    from,
    text,
    hop: 0,
    to: [],
  }) + '\n';

test('roomEnv reads the plugin env, defaults the main profile from OPTCHAT_HOME and refuses bad values', () => {
  const home = join(tmpdir(), 'optchat-room-env-home');
  assert.deepEqual(roomEnv({ OPTCHAT_HOME: home, OPTCHAT_ROOM: 'alarm-clock', OPTCHAT_ROOM_MEMBER: 'wallace', OPTCHAT_ROOM_DIR: '/r' }), {
    group: 'alarm-clock',
    member: 'wallace',
    dir: '/r',
    main: join(home, 'profiles', 'wallace'),
  });
  assert.equal(
    roomEnv({ OPTCHAT_ROOM: 'g', OPTCHAT_ROOM_MEMBER: 'wallace', OPTCHAT_ROOM_DIR: '/r', OPTCHAT_ROOM_MAIN: '/p/wallace' }).main,
    '/p/wallace',
  );
  assert.throws(() => roomEnv({ OPTCHAT_ROOM: 'Bad Group', OPTCHAT_ROOM_MEMBER: 'wallace', OPTCHAT_ROOM_DIR: '/r' }), /not a group id/);
  assert.throws(() => roomEnv({ OPTCHAT_ROOM: 'g', OPTCHAT_ROOM_DIR: '/r' }), /OPTCHAT_ROOM_MEMBER/);
  assert.throws(() => roomEnv({ OPTCHAT_ROOM: 'g', OPTCHAT_ROOM_MEMBER: '../x', OPTCHAT_ROOM_DIR: '/r' }), /Profile names/);
  assert.throws(() => roomEnv({ OPTCHAT_ROOM: 'g', OPTCHAT_ROOM_MEMBER: 'wallace' }), /OPTCHAT_ROOM_DIR/);
});

test('room_history pages back through room.jsonl, oldest first, skipping damaged lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-history-'));
  try {
    const file = join(dir, 'room.jsonl');
    assert.equal(roomHistory(file), 'No earlier room lines.');
    for (let i = 0; i < 60; i++)
      appendFileSync(file, line(`01M${String(i).padStart(3, '0')}`, i % 2 ? 'scrat' : 'sam', `line ${i}\nsecond`, i % 60));
    appendFileSync(file, '{"torn": \n');
    const newest = roomHistory(file, undefined, 3).split('\n');
    assert.deepEqual(newest, [
      '(57 earlier lines: room_history before=01M057)',
      '01M057  2026-10-13 16:57Z scrat: line 57 second',
      '01M058  2026-10-13 16:58Z sam: line 58 second',
      '01M059  2026-10-13 16:59Z scrat: line 59 second',
    ]);
    assert.deepEqual(roomHistory(file, '01M002', 10).split('\n'), [
      '01M000  2026-10-13 16:00Z sam: line 0 second',
      '01M001  2026-10-13 16:01Z scrat: line 1 second',
    ]);
    assert.equal(roomHistory(file, '01M030', 500).split('\n').length, 30, 'limit is at most 50; 30 lines are before 01M030');
    assert.equal(roomHistory(file, undefined, 500).split('\n').length, 51);
    assert.throws(() => roomHistory(file, 'nope'), /No room line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('room_history marks bot-room posts from a main chat; the member sees its own as "you"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-via-'));
  try {
    const file = join(dir, 'room.jsonl');
    appendFileSync(file, line('01MT', 'sam', '@peggy task: draft', 1));
    const post = (id: string, from: string) =>
      `${JSON.stringify({ v: 1, id, ts: '2026-10-13T16:02:00.000Z', group: 'alarm-clock', from, text: 'Done', hop: 1, to: [], re: '01MT', via: 'main' })}\n`;
    appendFileSync(file, post('01MP', 'peggy'));
    appendFileSync(file, post('01MQ', 'scrat'));
    assert.deepEqual(roomHistory(file, undefined, 20, 'peggy').split('\n').slice(1), [
      '01MP  2026-10-13 16:02Z peggy (you, from your main chat, re 01MT): Done',
      '01MQ  2026-10-13 16:02Z scrat (from its main chat, re 01MT): Done',
    ]);
    assert.match(roomHistory(file), /01MP {2}\S+ \S+ peggy \(from its main chat, re 01MT\): Done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the room prompt says a "(you, from your main chat …)" line is the bot\'s own bot-room post, never to answer', () => {
  const prompt = roomPrompt('peggy', 'alarm-clock').replace(/\s+/g, ' ');
  assert.match(prompt, /A line "peggy \(you, from your main chat, re <id>\)" is your own: your main chat posted it/);
  assert.match(prompt, /Never answer it or treat it as someone else's/);
});

/**
 * Stand-ins for the tools the user's global packages register in a real room session (pi-web-access, pi-fff,
 * rpiv-ask-user-question, plus pi's loaders), by their real names. Each records its calls.
 */
const PACKAGE_TOOLS = [
  'web_search',
  'fetch_content',
  'get_search_content',
  'source_check',
  'web_enable',
  'ffgrep',
  'fffind',
  'ask_user_question',
];
function packageTools(ran: { name: string; args: unknown }[]) {
  return (pi: ExtensionAPI) => {
    // As rpiv-ask-user-question does on the host: put its tool back into the active set before every run (loaded after
    // pi-optchat, so its handler runs after room mode's).
    pi.on('before_agent_start', () => {
      if (!pi.getActiveTools().includes('ask_user_question')) pi.setActiveTools([...pi.getActiveTools(), 'ask_user_question']);
    });
    for (const name of PACKAGE_TOOLS)
      pi.registerTool({
        name,
        label: name,
        description: `stand-in for ${name}`,
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute(_id: string, args: unknown) {
          ran.push({ name, args });
          return { content: [{ type: 'text' as const, text: `${name} ran` }], details: {} };
        },
      });
  };
}

/** Starts a real Pi session with pi-optchat loaded under `env`, answering with `reply(context)`. */
async function start(
  dir: string,
  env: Record<string, string>,
  reply: (context: Context, call: number) => AssistantMessage['content'],
  extensions: ((pi: ExtensionAPI) => void)[] = [],
) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const calls: { tools: string[]; system: string; context: Context }[] = [];
  try {
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
        // Pi hands providers a transcript: the prompt and tools are in its system messages.
        const tools = new Set<string>();
        let system = '';
        for (const message of context.messages) {
          if (message.role !== 'system') continue;
          system += textContent(message.content) + Object.values(message.sections ?? {}).join('\n');
          for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        }
        calls.push({ tools: [...tools].sort(), system, context: structuredClone(context) });
        const content = reply(context, calls.length);
        const message: AssistantMessage = {
          role: 'assistant',
          content,
          timestamp: Date.now(),
          stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop',
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
          stream.end();
        });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: env.OPTCHAT_ROOM_DIR ?? dir,
      agentDir: join(dir, 'agent'),
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [optchat, ...extensions],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      modelRuntime: runtime,
      model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.create(env.OPTCHAT_ROOM_DIR ?? dir, join(dir, 'sessions')),
      // No allowlist, as Paseo starts pi: the default tools (read, bash, edit, write) start active, and room mode must turn them off.
    });
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
    return { session, calls, errors };
  } catch (error) {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    throw error;
  }
}
const restoreEnv = (keys: string[], saved: Record<string, string | undefined>) => {
  for (const k of keys)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
};

test('room mode talks with only the room tools (talk + read-only lookups), its own prompt, the bot AGENTS.md and memory, and never touches the profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-mode-'));
  const home = join(dir, 'home'),
    roomDir = join(dir, 'rooms', 'alarm-clock');
  const keys = ['OPTCHAT_HOME', 'OPTCHAT_ROOM', 'OPTCHAT_ROOM_MEMBER', 'OPTCHAT_ROOM_DIR', 'PASEO_AGENT_ID'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    process.env.OPTCHAT_HOME = home;
    const profile = profilePath('wallace');
    const memory = new Memory(
      profile,
      async (input: Compression) => input.source.slice(0, 100),
      () => {},
    );
    memory.append('user', 'The launch is on 3 November.');
    memory.append('talk', 'Noted: launch 3 November.');
    memory.append('user', '[room alarm-clock block 01Mx msgs 01Ma-01Mb]\nroom:user: hush hush room talk');
    await memory.settle(AbortSignal.timeout(5000), true);
    await memory.close();
    writeFileSync(join(profile, 'AGENTS.md'), '# wallace\n\nYou are Wallace, the lead inventor.\n');
    mkdirSync(roomDir, { recursive: true });
    writeFileSync(
      join(roomDir, 'room.jsonl'),
      line('01MA', 'sam', '@wallace when is the launch?') + line('01MB', 'scrat', '@wallace date?', 41),
    );
    const before = snapshot(profile);

    const started = await start(
      dir,
      { OPTCHAT_ROOM: 'alarm-clock', OPTCHAT_ROOM_MEMBER: 'wallace', OPTCHAT_ROOM_DIR: roomDir, PASEO_AGENT_ID: 'room-agent-1' },
      (_context, call) =>
        call === 1
          ? [{ type: 'toolCall', id: 'h1', name: 'room_history', arguments: { limit: 5 } }]
          : call === 2
            ? [{ type: 'toolCall', id: 'z1', name: 'main_zoom', arguments: { id: 0, n: 1 } }]
            : [{ type: 'text', text: call === 3 ? '3 November, @scrat.' : 'PASS' }],
      [packageTools([])],
    );
    session = started.session;
    await session.prompt('[room alarm-clock to wallace msgs=2 hop=0]\n01MA  16:40Z sam: @wallace when is the launch?');
    await session.agent.waitForIdle();
    await session.prompt('[room alarm-clock to wallace msgs=1 hop=1]\n01MC  16:42Z scrat: thanks');
    await session.agent.waitForIdle();
    const { calls, errors } = started;
    assert.deepEqual(errors, []);
    assert.equal(calls.length, 4);
    // Exactly the allow-list: bash/edit/write and the packages' loaders, source_check and ask_user_question are off.
    for (const call of calls) assert.deepEqual(call.tools, [...ROOM_TOOLS].sort());
    const system = calls[0].system;
    assert.ok(system.includes(roomPrompt('wallace', 'alarm-clock')));
    assert.ok(system.includes('You are Wallace, the lead inventor.'));
    assert.match(system, /<main-memory>\n0\+1\|user: The launch is on 3 November\./);
    assert.doesNotMatch(system, /hush hush/);
    assert.ok(!system.includes(MASTER), 'not the main-chat prompt');
    assert.equal(calls[3].system, system, 'the prompt is taken once and kept, so its cache holds');
    const results = calls[2].context.messages.filter(m => m.role === 'toolResult').map(m => textContent(m.content));
    assert.deepEqual(results, [
      '01MA  2026-10-13 16:40Z sam: @wallace when is the launch?\n01MB  2026-10-13 16:41Z scrat: @wallace date?',
      '0+0|user: The launch is on 3 November.',
    ]);
    // Pi keeps the session's own history: the second turn sees the first.
    assert.ok(calls[3].context.messages.some(m => m.role === 'assistant' && textContent(m.content) === '3 November, @scrat.'));
    assert.deepEqual(snapshot(profile), before, 'nothing under the profile changed');
    assert.equal(existsSync(join(profile, 'lock.sock')), false);
    assert.equal(existsSync(join(home, 'last-profile')), false);
    assert.deepEqual(readdirSync(roomDir), ['room.jsonl'], 'room mode writes nothing in the room dir either');
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    restoreEnv(keys, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('room mode runs read-only lookups and blocks write tools and lookup options that write, spend or log in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-tools-'));
  const home = join(dir, 'home'),
    roomDir = join(dir, 'rooms', 'alarm-clock');
  const keys = ['OPTCHAT_HOME', 'OPTCHAT_ROOM', 'OPTCHAT_ROOM_MEMBER', 'OPTCHAT_ROOM_DIR'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    process.env.OPTCHAT_HOME = home;
    mkdirSync(profilePath('scrat'), { recursive: true });
    mkdirSync(roomDir, { recursive: true });
    writeFileSync(join(roomDir, 'notes.txt'), 'acorn count: 7\nOPENAI_API_KEY=sk-proj-0123456789abcdefghij\n');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'auth.json'), '{"anthropic":"sk-ant-oat01-secret"}');
    const touched = join(dir, 'touched');
    const ran: { name: string; args: unknown }[] = [];
    const started = await start(
      dir,
      { OPTCHAT_ROOM: 'alarm-clock', OPTCHAT_ROOM_MEMBER: 'scrat', OPTCHAT_ROOM_DIR: roomDir },
      (_context, call) =>
        call === 1
          ? ([
              { type: 'toolCall', id: 't1', name: 'web_search', arguments: { query: 'acorn prices' } },
              { type: 'toolCall', id: 't2', name: 'fetch_content', arguments: { url: 'https://example.com/a' } },
              { type: 'toolCall', id: 't3', name: 'read', arguments: { path: join(roomDir, 'notes.txt') } },
              { type: 'toolCall', id: 't4', name: 'bash', arguments: { command: `touch ${touched}` } },
              { type: 'toolCall', id: 't5', name: 'write', arguments: { path: touched, content: 'x' } },
              { type: 'toolCall', id: 't6', name: 'fetch_content', arguments: { url: 'https://example.com/b', auth: true } },
              {
                type: 'toolCall',
                id: 't7',
                name: 'fetch_content',
                arguments: { url: 'https://example.com/c', mode: 'answer', prompt: 'q' },
              },
              { type: 'toolCall', id: 't8', name: 'web_search', arguments: { query: 'x', workflow: 'summary-review' } },
              { type: 'toolCall', id: 't9', name: 'web_enable', arguments: {} },
              { type: 'toolCall', id: 't10', name: 'read', arguments: { path: join(home, '.ssh', 'id_ed25519') } },
              { type: 'toolCall', id: 't11', name: 'read', arguments: { path: join(home, '.pi', 'agent', 'auth.json') } },
              { type: 'toolCall', id: 't12', name: 'grep', arguments: { pattern: 'sk-', path: join(home, '.pi') } },
              { type: 'toolCall', id: 't13', name: 'fetch_content', arguments: { url: 'https://example.com/a?d=secret' } },
              { type: 'toolCall', id: 't14', name: 'fetch_content', arguments: { url: 'http://127.0.0.1:6767/api/status' } },
            ] as AssistantMessage['content'])
          : [{ type: 'text', text: 'Seven acorns.' }],
      [packageTools(ran)],
    );
    session = started.session;
    await session.prompt(
      '[room alarm-clock to scrat msgs=1 hop=0]\n01MA  16:40Z sam: @scrat how many acorns? https://example.com/a http://127.0.0.1:6767/api/status',
    );
    await session.agent.waitForIdle();
    assert.deepEqual(started.errors, []);
    assert.equal(started.calls.length, 2);
    assert.deepEqual(
      ran.map(r => r.name),
      ['web_search', 'fetch_content', 'fetch_content'],
      'only the plain lookups ran (t13: any public URL, option A); the blocked fetch/search options and web_enable did not',
    );
    assert.equal(existsSync(touched), false, 'bash and write did nothing');
    const results = new Map(
      started.calls[1].context.messages
        .filter(m => m.role === 'toolResult')
        .map(m => [(m as { toolCallId: string }).toolCallId, textContent(m.content)]),
    );
    assert.match(results.get('t3')!, /acorn count: 7/);
    assert.match(results.get('t3')!, /OPENAI_API_KEY=\[redacted\]/, 'token shapes are taken out of file results');
    assert.doesNotMatch(results.get('t3')!, /sk-proj/);
    for (const id of ['t4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12', 't14'])
      assert.doesNotMatch(results.get(id) ?? '', /ran$|acorn/, id);
    assert.match(results.get('t6')!, /browser logins/);
    assert.match(results.get('t7')!, /readable or raw/);
    assert.match(results.get('t8')!, /workflows/);
    assert.match(results.get('t10')!, /credentials/);
    assert.match(results.get('t11')!, /credentials/);
    assert.match(results.get('t12')!, /outside the folders a room may read/);
    assert.equal(results.get('t13'), 'fetch_content ran', 'a public URL the bot wrote itself is fetched (no seen-URL rule)');
    assert.match(results.get('t14')!, /private or local/);
    assert.doesNotMatch(JSON.stringify(started.calls[1].context), /sk-ant-oat01-secret/);
    // The active set never grew: web_enable was blocked before it could add tools.
    for (const call of started.calls) assert.deepEqual(call.tools, [...ROOM_TOOLS].sort());
    assert.ok(ROOM_LOOKUP_TOOLS.every(t => started.calls[0].tools.includes(t)));
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    restoreEnv(keys, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full tools (rooms.fullTools in the settings file) give a room its main chat tools, and switching back applies on the next turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-full-'));
  const home = join(dir, 'home'),
    roomDir = join(dir, 'rooms', 'alarm-clock'),
    settingsFile = join(dir, 'bots', '.settings.json');
  const keys = ['OPTCHAT_HOME', 'OPTCHAT_ROOM', 'OPTCHAT_ROOM_MEMBER', 'OPTCHAT_ROOM_DIR', 'OPTCHAT_ROOM_SETTINGS'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    process.env.OPTCHAT_HOME = home;
    mkdirSync(profilePath('scrat'), { recursive: true });
    mkdirSync(roomDir, { recursive: true });
    mkdirSync(join(dir, 'bots'), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ rooms: { fullTools: true } }));
    writeFileSync(join(roomDir, 'notes.txt'), 'OPENAI_API_KEY=sk-proj-0123456789abcdefghij\n');
    const touched = join(dir, 'touched'),
      touchedLater = join(dir, 'touched-later');
    const ran: { name: string; args: unknown }[] = [];
    const started = await start(
      dir,
      { OPTCHAT_ROOM: 'alarm-clock', OPTCHAT_ROOM_MEMBER: 'scrat', OPTCHAT_ROOM_DIR: roomDir, OPTCHAT_ROOM_SETTINGS: settingsFile },
      (_context, call) =>
        call === 1
          ? ([
              { type: 'toolCall', id: 'f1', name: 'bash', arguments: { command: `touch ${touched}` } },
              { type: 'toolCall', id: 'f2', name: 'ask_user_question', arguments: {} },
              { type: 'toolCall', id: 'f3', name: 'web_enable', arguments: {} },
              { type: 'toolCall', id: 'f4', name: 'read', arguments: { path: join(roomDir, 'notes.txt') } },
            ] as AssistantMessage['content'])
          : call === 3
            ? ([
                { type: 'toolCall', id: 'l1', name: 'bash', arguments: { command: `touch ${touchedLater}` } },
                { type: 'toolCall', id: 'l2', name: 'read', arguments: { path: join(roomDir, 'notes.txt') } },
              ] as AssistantMessage['content'])
            : [{ type: 'text', text: 'Done.' }],
      [packageTools(ran)],
    );
    session = started.session;
    await session.prompt('[room alarm-clock to scrat msgs=1 hop=0]\n01MA  16:40Z sam: @scrat make the file');
    await session.agent.waitForIdle();
    // The user switches group chats back to lookup tools in the app: the same live session follows on its next turn.
    writeFileSync(settingsFile, JSON.stringify({ rooms: { fullTools: false } }));
    await session.prompt('[room alarm-clock to scrat msgs=1 hop=0]\n01MB  16:41Z sam: @scrat again');
    await session.agent.waitForIdle();
    // And on again: the main chat's tools come back (taken when the session started, before room mode trimmed them).
    writeFileSync(settingsFile, JSON.stringify({ rooms: { fullTools: true } }));
    await session.prompt('[room alarm-clock to scrat msgs=1 hop=0]\n01MC  16:42Z sam: @scrat thanks');
    await session.agent.waitForIdle();
    const { calls, errors } = started;
    assert.deepEqual(errors, []);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls[4].tools, calls[0].tools, 'full again');
    for (const tool of ['bash', 'edit', 'write', 'read', ...ROOM_TOOLS.slice(0, 4), 'web_enable', 'source_check'])
      assert.ok(calls[0].tools.includes(tool), `full: ${tool}`);
    assert.ok(!calls[0].tools.includes('ask_user_question'), 'never in a room');
    assert.match(calls[0].system, /same tools as your main chat/);
    assert.equal(existsSync(touched), true, 'bash ran with full tools');
    const first = new Map(
      calls[1].context.messages
        .filter(m => m.role === 'toolResult')
        .map(m => [(m as { toolCallId: string }).toolCallId, textContent(m.content)]),
    );
    assert.match(first.get('f2')!, /no one answers/);
    assert.equal(first.get('f3'), 'web_enable ran');
    assert.match(first.get('f4')!, /sk-proj-0123456789abcdefghij/, 'full tools read files as a main chat does');
    // Turn 2, lookup again.
    for (const call of calls.slice(2, 4)) assert.deepEqual(call.tools, [...ROOM_TOOLS].sort());
    assert.match(calls[2].system, /You cannot change anything here/);
    assert.equal(existsSync(touchedLater), false, 'bash blocked once full tools are off');
    const second = new Map(
      calls[3].context.messages
        .filter(m => m.role === 'toolResult')
        .map(m => [(m as { toolCallId: string }).toolCallId, textContent(m.content)]),
    );
    assert.match(second.get('l1')!, /not found|not available in a group chat room/, 'inactive again, and blocked anyway');
    assert.match(second.get('l2')!, /OPENAI_API_KEY=\[redacted\]/);
    assert.deepEqual(
      ran.map(r => r.name),
      ['web_enable'],
    );
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    restoreEnv(keys, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('room mode without a member refuses input instead of opening a profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-room-fault-'));
  const keys = ['OPTCHAT_HOME', 'OPTCHAT_ROOM', 'OPTCHAT_ROOM_MEMBER', 'OPTCHAT_ROOM_DIR'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    process.env.OPTCHAT_HOME = join(dir, 'home');
    delete process.env.OPTCHAT_ROOM_MEMBER;
    const started = await start(dir, { OPTCHAT_ROOM: 'alarm-clock', OPTCHAT_ROOM_DIR: dir }, () => [{ type: 'text', text: 'no' }]);
    session = started.session;
    await session.prompt('hello');
    await session.agent.waitForIdle();
    assert.equal(started.calls.length, 0);
    assert.match(started.errors.join('\n'), /OPTCHAT_ROOM_MEMBER is not set/);
    assert.equal(existsSync(join(dir, 'home')), false, 'no OptChat home was created');
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    restoreEnv(keys, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});
