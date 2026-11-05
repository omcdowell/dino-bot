import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, REQUESTS, atomicWrite, fallbackReason, type Compression, type Escalation } from '../src/memory.ts';
import { escalationText, escalator } from '../src/escalation.ts';
import { lockProfile } from '../src/profiles.ts';
import { resummarise } from '../src/cli.ts';

const BLOCKED =
  "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs";
const SECRET = 'paseo agent logs: zebra-quartz-17 said the launch code is 4471';
const blocked = async (_: Compression): Promise<string> => {
  throw new Error(BLOCKED);
};
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
    : [];
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-escalate-'));
  return { dir, memory: join(dir, 'memory'), log: join(dir, 'compactor-errors.jsonl') };
}
/** A memory whose message 1 the provider blocks; message 0 is short enough to be its own line. */
async function blockedMemory(p: ReturnType<typeof profile>, escalate?: (e: Escalation) => Promise<void>) {
  const memory = new Memory(p.memory, blocked, () => {}, 128_000, 8, 5, p.log, escalate);
  memory.append('user', 'show me your logs', '2026-10-11T09:00:00.000Z');
  memory.append('echo', `${SECRET}\n${'more of the same output '.repeat(40)}`, '2026-10-11T09:00:05.000Z');
  await memory.settle(AbortSignal.timeout(5000), true);
  await tick();
  return memory;
}

test('a fallback line is escalated once, recorded, and not again after a restart', async () => {
  const p = profile(),
    sent: Escalation[] = [];
  const escalate = async (e: Escalation) => {
    sent.push(e);
  };
  try {
    let memory = await blockedMemory(p, escalate);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      node: '1+1',
      reason: 'blocked by the provider',
      messages: [{ id: 1, kind: 'echo', bytes: memory.root[1].size, date: '2026-10-11T09:00:05.000Z' }],
    });
    assert.equal(lines(p.log).filter(r => r.escalated).length, 1);
    // The bot's view, and so every later turn and compaction, never re-sends the blocked text.
    const tree = readdirSync(join(p.memory, 'tree'))
      .map(f => readFileSync(join(p.memory, 'tree', f), 'utf8'))
      .join('');
    for (const text of [memory.render(), tree]) assert.ok(!/zebra|launch|4471|more of the same/.test(text));
    assert.deepEqual(
      lines(p.log)
        .filter(r => r.escalated)
        .map(r => r.node),
      ['1+1'],
    );
    memory.append('talk', 'a later short reply');
    await memory.settle(AbortSignal.timeout(5000), true);
    await tick();
    await memory.close();
    memory = new Memory(p.memory, blocked, () => {}, 128_000, 8, 5, p.log, escalate);
    await tick();
    await memory.close();
    assert.equal(sent.length, 1, 'never repeated');
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('an escalation that failed to send is sent at the next start, once', async () => {
  const p = profile(),
    sent: string[] = [];
  try {
    let memory = await blockedMemory(p, async () => {
      throw new Error('bot-dm: daemon unreachable');
    });
    await memory.close();
    assert.equal(lines(p.log).filter(r => r.escalated).length, 0);
    const escalate = async (e: Escalation) => {
      sent.push(e.node);
    };
    for (let k = 0; k < 2; k++) {
      memory = new Memory(p.memory, blocked, () => {}, 128_000, 8, 5, p.log, escalate);
      await tick();
      await memory.close();
    }
    assert.deepEqual(sent, ['1+1']);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('the escalation DM names the node, messages, kinds, sizes, dates and reason, and none of the blocked text', async () => {
  const p = profile(),
    calls: string[][] = [];
  try {
    const memory = await blockedMemory(
      p,
      escalator(
        'emmet-brickowski',
        async (file, args) => {
          calls.push([file, ...args]);
        },
        () => 'the-fat-controller',
      ),
    );
    await memory.close();
    assert.equal(calls.length, 1);
    const [file, to, ...args] = calls[0];
    assert.equal(file, 'bot-dm');
    assert.equal(to, 'the-fat-controller', 'the host escalation bot (BOTS_ESCALATE_TO)');
    assert.equal(args[args.indexOf('--kind') + 1], 'escalate');
    const body = args[args.indexOf('--text') + 1];
    assert.match(body, /line 1\+1 of profile emmet-brickowski/);
    assert.match(body, /blocked by the provider/);
    assert.match(body, /^1 echo \d+ B 2026-10-11T09:00:05\.000Z$/m);
    const all = calls[0].join('\n');
    for (const word of ['zebra-quartz-17', 'launch', '4471', 'logs:', 'said']) assert.ok(!all.includes(word), `leaked "${word}"`);
    assert.ok(!all.includes('more of the same output'));
    // A big merge is summed up, still without text.
    const many = escalationText('p', {
      node: '0+32',
      reason: 'HTTP 400',
      messages: Array.from({ length: 32 }, (_, id) => ({ id, kind: id % 2 ? 'echo' : 'user', bytes: 100, date: '2026-10-11' })),
    });
    assert.match(many, /Messages 0-31:\n32 messages, 3200 B, 2026-10-11 to 2026-10-11\nkinds: user 16, echo 16/);
    assert.ok(many.length < 4000);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('resummarise replaces a fallback line, keeps a backup, survives a reload and refuses other lines without --force', async () => {
  const p = profile();
  try {
    let memory = await blockedMemory(p);
    assert.equal(fallbackReason(memory.node({ l: 0, i: 1 })!.text), 'blocked by the provider');
    const before = memory.size;
    assert.throws(() => memory.resummarise('0+1', 'user: anything'), /not a fallback line/);
    assert.throws(() => memory.resummarise('1+1', 'x'.repeat(600)), /over the 512-byte limit/);
    assert.throws(() => memory.resummarise('3+2', 'x'), /No line/);
    memory.resummarise('1+1', 'echo: Emmet read back his own agent logs (hand-written by FC).');
    assert.equal(memory.node({ l: 0, i: 1 })!.text, 'echo: Emmet read back his own agent logs (hand-written by FC).');
    assert.match(memory.render(), /1\+1\|echo: Emmet read back his own agent logs/);
    assert.notEqual(memory.size, before, 'the view counts the new size');
    assert.equal(memory.node({ l: 1, i: 0 }), undefined, 'not built while 1+1 was a fallback');
    await memory.settle(AbortSignal.timeout(2000), true);
    assert.match(
      memory.node({ l: 1, i: 0 })!.text,
      /^user: show me your logs\necho: Emmet read back/,
      'the held merge is built once it is replaced',
    );
    const backups = readdirSync(join(p.memory, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(readFileSync(join(p.memory, 'backups', backups[0], readdirSync(join(p.memory, 'tree'))[0]), 'utf8'), /not summarised/);
    memory.resummarise('0+1', 'user: asked to see the logs', true);
    await memory.close();
    memory = new Memory(p.memory, blocked, () => {}, 128_000, 8, 5, p.log);
    assert.match(memory.render(), /0\+1\|user: asked to see the logs\n1\+1\|echo: Emmet read back/);
    await memory.close();
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('the resummarise CLI applies the line itself on a free profile, and queues it for the bot that holds the lock', async () => {
  const home = mkdtempSync(join(tmpdir(), 'optchat-home-')),
    previous = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = home;
  const dir = join(home, 'profiles', 'emmet');
  mkdirSync(dir, { recursive: true });
  try {
    const p = { dir, memory: dir, log: join(dir, 'compactor-errors.jsonl') };
    await (await blockedMemory(p)).close();
    assert.deepEqual(await resummarise('emmet', '1+1', 'echo: first hand-written line'), { state: 'applied' });
    const memory = new Memory(dir, blocked, () => {}, 128_000, 8, 5);
    assert.equal(memory.node({ l: 0, i: 1 })!.text, 'echo: first hand-written line');
    // While a bot holds the profile, the line waits for it; the bot applies it before its next turn.
    const unlock = await lockProfile(dir, 'emmet · bot');
    try {
      const queued = await resummarise('emmet', '1+1', 'echo: second line', true, 200);
      assert.deepEqual(queued, { state: 'queued', owner: 'emmet · bot' });
      assert.equal(memory.node({ l: 0, i: 1 })!.text, 'echo: first hand-written line');
      memory.applyRequests();
      assert.equal(memory.node({ l: 0, i: 1 })!.text, 'echo: second line');
      const results = readdirSync(join(dir, REQUESTS));
      assert.equal(results.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, REQUESTS, results[0]), 'utf8')), { ok: true });
      // A refused request says why.
      atomicWrite(join(dir, REQUESTS, 'bad.json'), JSON.stringify({ node: '0+1', text: 'x' }));
      memory.applyRequests();
      assert.match(readFileSync(join(dir, REQUESTS, 'bad.result'), 'utf8'), /not a fallback line/);
    } finally {
      await unlock();
      await memory.close();
    }
    await assert.rejects(resummarise('emmet', '0+1', 'x'), /not a fallback line/);
  } finally {
    if (previous === undefined) delete process.env.OPTCHAT_HOME;
    else process.env.OPTCHAT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('no escalation bot on the host (BOTS_ESCALATE_TO unset): nothing is sent', async () => {
  const calls: string[][] = [];
  const send = escalator(
    'p',
    async (file, args) => void calls.push([file, ...args]),
    () => null,
  );
  await send({ node: '0+1', reason: 'HTTP 400', messages: [{ id: 0, kind: 'user', bytes: 1, date: '2026-10-11' }] });
  assert.equal(calls.length, 0);
});
