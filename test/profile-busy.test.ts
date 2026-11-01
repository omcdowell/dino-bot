import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, loadConfig, lockProfile, profilePath, profileSocket, saveConfig, SOCKET_PATH_LIMIT } from '../src/profiles.ts';

const agentDir = (process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-')));
after(() => rmSync(agentDir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function start(dir: string, ui: Partial<ExtensionUIContext>, bound?: string, talked = false, mode: 'tui' | 'rpc' = 'tui') {
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
  if (bound) manager.appendCustomEntry('optchat.profile', { name: bound });
  if (talked) manager.appendMessage({ role: 'user', content: 'earlier turn', timestamp: Date.now() });
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader,
    settingsManager,
    sessionManager: manager,
    tools: ['zoom'],
  });
  const titles: string[] = [],
    errors: string[] = [];
  const uiContext: ExtensionUIContext = {
    ...session.extensionRunner.getUIContext(),
    setTitle: t => {
      titles.push(t);
    },
    notify: (text, type) => {
      if (type === 'error') errors.push(text);
    },
    ...ui,
  };
  await session.bindExtensions({ uiContext, mode });
  return { session, titles, errors, manager };
}

test('RPC mode without a requested profile skips the picker and warns, so headless launchers never block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-rpc-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  try {
    createProfile('someone');
    const asked: string[] = [];
    const warnings: string[] = [];
    const { session, errors } = await start(
      dir,
      {
        select: async title => {
          asked.push(title);
          return undefined;
        },
        notify: (text, type) => {
          if (type === 'warning') warnings.push(text);
        },
      },
      undefined,
      false,
      'rpc',
    );
    assert.deepEqual(asked, []);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /\.optchat-profile/);
    session.dispose();
  } finally {
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy profile offers to pick another profile, and picking another opens it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-busy-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  const sessions: Awaited<ReturnType<typeof start>>['session'][] = [];
  let unlock: (() => Promise<void>) | undefined;
  try {
    for (const name of ['busy', 'other', 'third']) {
      createProfile(name);
      const config = loadConfig(profilePath(name));
      saveConfig(profilePath(name), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    }
    unlock = await lockProfile(profilePath('busy'), 'busy · PID 1 · elsewhere');

    // New session: pick `busy`, it's taken, choose "Pick another profile", then pick `other`.
    const asked: { title: string; options: string[] }[] = [];
    const picks = ['busy', 'Pick another profile', 'other'];
    const fresh = await start(dir, {
      select: async (title, options) => {
        asked.push({ title, options });
        return picks.shift();
      },
    });
    sessions.push(fresh.session);
    assert.deepEqual(
      asked.map(a => a.title.split('\n')[0]),
      ['OptChat profile', 'busy is open in another window', 'OptChat profile'],
    );
    assert.match(asked[1].title, /busy · PID 1 · elsewhere/);
    assert.deepEqual(asked[1].options, ['Pick another profile']);
    assert.equal(fresh.titles[0], 'π other');
    assert.deepEqual(fresh.errors, []);
    const bound = fresh.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(
      bound.map(e => e.type === 'custom' && e.data),
      [{ name: 'other' }],
      'the session is bound to the profile actually opened',
    );

    // `/optchat profile` makes a fresh session already bound to its pick; a busy pick can still pick another and rebind.
    const switchedPicks = ['Pick another profile', 'third']; // `other` is held by the session above
    const switched = await start(dir, { select: async () => switchedPicks.shift() }, 'busy');
    sessions.push(switched.session);
    assert.equal(switched.titles[0], 'π third');
    assert.deepEqual(switched.errors, []);
    const rebound = switched.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(
      rebound.map(e => e.type === 'custom' && e.data),
      [{ name: 'busy' }, { name: 'third' }],
      'the latest binding wins',
    );

    // A resumed conversation already belongs to `busy`, so it can't switch: it reports the busy profile.
    const resumedAsked: string[][] = [];
    const resumed = await start(
      dir,
      {
        select: async (_title, options) => {
          resumedAsked.push(options);
          return undefined;
        },
      },
      'busy',
      true,
    );
    sessions.push(resumed.session);
    assert.deepEqual(resumedAsked, []);
    assert.match(resumed.errors.join('\n'), /Profile already running/);
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    await unlock?.();
    await sleep(50);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a client that hangs up early does not crash the process holding the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-'));
  const unlock = await lockProfile(dir, 'holder');
  try {
    const path = profileSocket(dir);
    for (let round = 0; round < 20; round++) {
      await Promise.all(
        Array.from(
          { length: 50 },
          () =>
            new Promise<void>(done => {
              const client = createConnection(path);
              client.on('error', () => done());
              client.on('connect', () => {
                client.destroy();
                done();
              });
            }),
        ),
      );
      await sleep(5);
    }
    await sleep(100);
    await assert.rejects(lockProfile(dir, 'second'), /holder/);
  } finally {
    await unlock();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two Pis with different TMPDIRs still share one profile lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-')),
    oldTmp = process.env.TMPDIR;
  const temps = [mkdtempSync(join(tmpdir(), 'optchat-tmp-a-')), mkdtempSync(join(tmpdir(), 'optchat-tmp-b-'))];
  process.env.TMPDIR = temps[0];
  const unlock = await lockProfile(dir, 'first');
  try {
    process.env.TMPDIR = temps[1];
    await assert.rejects(lockProfile(dir, 'second'), /first/);
  } finally {
    await unlock();
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
    for (const path of [dir, ...temps]) rmSync(path, { recursive: true, force: true });
  }
});

test('a regular file named like the lock socket is refused, not deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-'));
  try {
    writeFileSync(profileSocket(dir), 'notes');
    await assert.rejects(lockProfile(dir, 'holder'), /is not an OptChat socket/);
    assert.equal(readFileSync(profileSocket(dir), 'utf8'), 'notes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a socket path over the system limit names OPTCHAT_HOME and its length without binding a truncated socket, and one at the limit locks', async () => {
  const root = mkdtempSync('/tmp/oc.');
  try {
    const fileLength = Buffer.byteLength(basename(profileSocket(root)));
    const profileOf = (socketLength: number) => {
      const dir = join(root, 'q'.repeat(socketLength - fileLength - 1 - root.length - 1));
      mkdirSync(dir);
      return dir;
    };
    const atLimit = profileOf(SOCKET_PATH_LIMIT),
      overLimit = profileOf(SOCKET_PATH_LIMIT + 1),
      long = join(root, 'p'.repeat(200));
    mkdirSync(long);

    assert.equal(Buffer.byteLength(profileSocket(atLimit)), SOCKET_PATH_LIMIT);
    const unlock = await lockProfile(atLimit, 'holder');
    await unlock();

    for (const dir of [overLimit, long]) {
      await assert.rejects(lockProfile(dir, 'holder'), /OPTCHAT_HOME to a shorter directory/);
      await assert.rejects(lockProfile(dir, 'holder'), new RegExp(`${Buffer.byteLength(profileSocket(dir))} bytes`));
      assert.deepEqual(readdirSync(dir), [], 'no truncated socket was bound');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a second writer that got past the lock is refused on its next turn, with the log intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-writer-')),
    oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    createProfile('shared');
    saveConfig(profilePath('shared'), {
      ...loadConfig(profilePath('shared')),
      compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' },
    });
    const opened = await start(dir, { select: async () => 'shared' });
    session = opened.session;
    const other = new Memory(
      profilePath('shared'),
      async () => 'summary',
      () => {},
    );
    other.append('user', 'written by the other process');
    await other.close();

    await session.prompt('Question for the first process');
    await session.agent.waitForIdle();
    assert.match(opened.errors.join('\n'), /Another process wrote .*nothing was written/);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
  }
  const reopened = new Memory(
    join(dir, 'home', 'profiles', 'shared'),
    async () => 'summary',
    () => {},
  );
  try {
    assert.deepEqual(
      reopened.root.map(e => e.text),
      ['written by the other process'],
    );
  } finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-08: Paseo's provider catalog probe (`pi -e pi-optchat` in the bot's folder) started alongside Bitzer's real
// resume, took the profile lock for a few seconds and exited. The real Pi lost the race, kept running without its
// profile and swallowed every input until it was restarted by hand.
/** A headless Pi in a bot folder. Paseo sets PASEO_AGENT_ID on its agent sessions; its catalog probe has none (`agentId: null`). */
async function headless(dir: string, profile: string, agentId: string | null = '11ba726e-real-session') {
  writeFileSync(join(dir, '.optchat-profile'), profile);
  const old = process.env.PASEO_AGENT_ID;
  if (agentId === null) delete process.env.PASEO_AGENT_ID;
  else process.env.PASEO_AGENT_ID = agentId;
  try {
    return await start(dir, {}, undefined, false, 'rpc');
  } finally {
    if (old === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = old;
  }
}
function fixtureProfile(name: string) {
  createProfile(name);
  saveConfig(profilePath(name), {
    ...loadConfig(profilePath(name)),
    compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' },
  });
}

test('a headless Pi that starts while a short-lived probe holds its profile waits for the probe to exit and opens the profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-probe-')),
    oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    fixtureProfile('bot');
    const probe = await lockProfile(profilePath('bot'), 'bot · PID 1297541 · probe');
    setTimeout(() => void probe(), 400);
    const opened = await headless(dir, 'bot');
    session = opened.session;
    assert.deepEqual(opened.errors, []);
    assert.equal(opened.titles[0], 'π bot', 'the profile is open');
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

test('a Pi that started while its profile was busy opens the profile on its next input once the holder has gone, so the turn reaches memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-late-')),
    oldHome = process.env.OPTCHAT_HOME,
    oldWait = process.env.OPTCHAT_BUSY_WAIT_MS;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  process.env.OPTCHAT_BUSY_WAIT_MS = '100';
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    fixtureProfile('bot');
    const holder = await lockProfile(profilePath('bot'), 'bot · PID 1297541 · probe');
    const opened = await headless(dir, 'bot');
    session = opened.session;
    assert.match(opened.errors.join('\n'), /Profile already running: bot · PID 1297541/);
    await holder();

    await session.prompt('Question after the holder left');
    await session.agent.waitForIdle();
    assert.equal(opened.titles.at(-1), 'π bot', 'the profile opened on input');
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
    if (oldWait === undefined) delete process.env.OPTCHAT_BUSY_WAIT_MS;
    else process.env.OPTCHAT_BUSY_WAIT_MS = oldWait;
  }
  const memory = new Memory(
    join(dir, 'home', 'profiles', 'bot'),
    async () => 'summary',
    () => {},
  );
  try {
    assert.ok(
      memory.root.some(e => e.text.includes('Question after the holder left')),
      'the input was written to the profile memory',
    );
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('input while the profile is still busy is refused with the holder named, and is not run without memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-still-')),
    oldHome = process.env.OPTCHAT_HOME,
    oldWait = process.env.OPTCHAT_BUSY_WAIT_MS;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  process.env.OPTCHAT_BUSY_WAIT_MS = '100';
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  const holder = await (async () => {
    fixtureProfile('bot');
    return lockProfile(profilePath('bot'), 'bot · PID 42 · elsewhere');
  })();
  try {
    const opened = await headless(dir, 'bot');
    session = opened.session;
    const before = opened.errors.length;
    await session.prompt('Question while busy');
    await session.agent.waitForIdle();
    assert.match(opened.errors.slice(before).join('\n'), /Profile already running: bot · PID 42/);
    assert.equal(session.messages.filter(m => m.role === 'user').length, 0, 'no turn ran without the profile');
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    await holder();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
    if (oldWait === undefined) delete process.env.OPTCHAT_BUSY_WAIT_MS;
    else process.env.OPTCHAT_BUSY_WAIT_MS = oldWait;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a catalog probe (RPC, no PASEO_AGENT_ID) never takes the profile lock, so a real session starting beside it opens at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-catalog-')),
    oldHome = process.env.OPTCHAT_HOME,
    oldWait = process.env.OPTCHAT_BUSY_WAIT_MS;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  process.env.OPTCHAT_BUSY_WAIT_MS = '0'; // no fallback wait: the real session must not need it
  const sessions: Awaited<ReturnType<typeof start>>['session'][] = [];
  try {
    fixtureProfile('bot');
    const probe = await headless(dir, 'bot', null);
    sessions.push(probe.session);
    assert.deepEqual(probe.errors, []);
    assert.deepEqual(probe.titles, [], 'the probe did not open the profile');
    // What Paseo's fetchCatalog asks for; neither needs the profile.
    assert.ok((await probe.session.modelRuntime.getAvailable()).length > 0);
    const free = await lockProfile(profilePath('bot'), 'checker');
    await free();

    const real = await headless(dir, 'bot');
    sessions.push(real.session);
    assert.deepEqual(real.errors, []);
    assert.equal(real.titles[0], 'π bot', 'the real session holds the profile');
    await assert.rejects(lockProfile(profilePath('bot'), 'checker'), /PID/);

    await probe.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    await assert.rejects(lockProfile(profilePath('bot'), 'checker'), /PID/, 'the probe exiting leaves the real lock alone');
  } finally {
    for (const session of sessions) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
    if (oldWait === undefined) delete process.env.OPTCHAT_BUSY_WAIT_MS;
    else process.env.OPTCHAT_BUSY_WAIT_MS = oldWait;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Paseo agent session (PASEO_AGENT_ID set) takes the profile lock at start, before any input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-agent-')),
    oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    fixtureProfile('bot');
    const opened = await headless(dir, 'bot', 'a734581d-agent');
    session = opened.session;
    assert.deepEqual(opened.errors, []);
    assert.equal(opened.titles[0], 'π bot');
    await assert.rejects(lockProfile(profilePath('bot'), 'checker'), new RegExp(`bot · PID ${process.pid}`));
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

test('an RPC start without PASEO_AGENT_ID that does get input opens the profile then, so the turn reaches memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-deferred-')),
    oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    fixtureProfile('bot');
    const opened = await headless(dir, 'bot', null);
    session = opened.session;
    assert.deepEqual(opened.titles, []);
    await session.prompt('Question to a deferred session');
    await session.agent.waitForIdle();
    assert.equal(opened.titles.at(-1), 'π bot', 'the profile opened on input');
    const bound = opened.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(
      bound.map(e => e.type === 'custom' && e.data),
      [{ name: 'bot' }],
    );
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = oldHome;
  }
  const memory = new Memory(
    join(dir, 'home', 'profiles', 'bot'),
    async () => 'summary',
    () => {},
  );
  try {
    assert.ok(memory.root.some(e => e.text.includes('Question to a deferred session')));
  } finally {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
