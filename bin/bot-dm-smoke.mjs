#!/usr/bin/env node
// bot-dm smoke test. Re-run after every Paseo upgrade (npm i -g @getpaseo/cli), then add the new
// version to PINNED_CLI_VERSIONS in bot-dm/paseo.ts if it passes.
//
//   bin/bot-dm-smoke.mjs                 static + daemon checks (read-only; sends nothing)
//   bin/bot-dm-smoke.mjs --live <tmp-*>  also sends to a throwaway bot: idle start, steer into a
//                                        busy turn, daemon dedupe of a repeated messageId
//
// --live only accepts recipients whose name starts with "tmp-" and runs bot-dm with
// BOT_DM_RECIPIENT_PREFIX=tmp-, so it cannot reach a real bot. Create a tmp bot as in
// research/bot-dms/reports/05-check-steer.md (short OPTCHAT_HOME, gotcha 7), labelled bot=<name>.
// Exit 0 if every check passed.

const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  return emitWarning.call(this, warning, ...rest);
};

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const BOT_DM = join(here, 'bot-dm.mjs');
const { PINNED_CLI_VERSIONS, cliDist, cliVersion, connectPaseo, loadCliInternals } = await import('../bot-dm/paseo.ts');

const { values: opt } = parseArgs({ options: { live: { type: 'string' } } });
if (opt.live !== undefined && !/^tmp-[a-z0-9_-]+$/.test(opt.live)) {
  console.error('--live takes a throwaway bot whose name starts with tmp-');
  process.exit(2);
}

let failed = 0;
const check = async (name, fn) => {
  try {
    const note = await fn();
    console.log(`ok   ${name}${note ? `: ${note}` : ''}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static ----------------------------------------------------------------------------------
const dist = cliDist();
const version = cliVersion(dist);
await check('Paseo CLI version is pinned', () => {
  assert(PINNED_CLI_VERSIONS.includes(version), `${version} not in ${PINNED_CLI_VERSIONS.join(', ')} (finish this run, then update the list)`);
  return version;
});
await check('CLI internals load (utils/client.js connectToDaemon, utils/daemon-target.js selectDaemonTarget)', async () => {
  await loadCliInternals(dist);
  return dist;
});
await check('bin/bot-dm.mjs runs under plain Node', () => {
  const r = spawnSync(process.execPath, [BOT_DM, '--help'], { encoding: 'utf8' });
  assert(r.status === 0 && r.stdout.startsWith('Usage: bot-dm') && r.stderr === '', `exit ${r.status}: ${r.stderr}`);
});

// ---- daemon (read-only) ----------------------------------------------------------------------
let paseo;
await check('connect to the daemon and list agents (paged)', async () => {
  paseo = await connectPaseo(process.env);
  const agents = await paseo.listAgents();
  assert(Array.isArray(agents) && agents.every((a) => a.id && 'labels' in a && 'status' in a), 'unexpected agent shape');
  return `${agents.length} live agents, ${agents.filter((a) => a.labels.bot).length} with bot= labels`;
});

// ---- live, tmp bot only ----------------------------------------------------------------------
if (opt.live && paseo) {
  const to = opt.live;
  const env = { ...process.env, BOT_DM_RECIPIENT_PREFIX: 'tmp-', PASEO_AGENT_ID: '' };
  const dm = (args) => {
    const r = spawnSync(process.execPath, [BOT_DM, to, '--from', 'worker:bot-dm-smoke', '--kind', 'report', ...args], { encoding: 'utf8', env });
    assert(r.status === 0, `bot-dm exit ${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const agentOf = async () => {
    const hit = (await paseo.listAgents()).filter((a) => a.labels.bot === to);
    assert(hit.length === 1, `expected one live agent labelled bot=${to}, found ${hit.length}`);
    return hit[0];
  };
  const waitFor = async (want, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const a = await agentOf();
      if (want(a.status)) return a;
      if (Date.now() > end) throw new Error(`timed out; status ${a.status}`);
      await sleep(1000);
    }
  };
  const logs = (id) => execFileSync('paseo', ['logs', id], { encoding: 'utf8' });
  const tag = Date.now().toString(36).toUpperCase();

  await check(`idle send starts a turn (${to})`, async () => {
    const a = await waitFor((s) => s === 'idle', 120_000);
    const out = dm(['--text', `Smoke ${tag}: reply with the single word IDLE-${tag}.`]);
    assert(out.status === 'started' && out.activeTurnBehavior === 'steer', JSON.stringify(out));
    await sleep(3000);
    await waitFor((s) => s === 'idle', 180_000);
    const text = logs(a.id);
    assert(text.includes(`[User] [dm ${out.id} from worker:bot-dm-smoke to ${to} kind=report`), 'envelope not first line of a user message');
    assert(text.includes(`IDLE-${tag}`), 'no reply');
  });

  await check('steer lands between tool calls of a busy turn, without aborting it', async () => {
    const a = await waitFor((s) => s === 'idle', 120_000);
    execFileSync('paseo', ['send', '--no-wait', a.id,
      `Smoke ${tag}: run 'sleep 15; echo S1-${tag}' and then 'sleep 15; echo S2-${tag}' as two separate shell tool calls, then reply DONE-${tag} and any token you saw meanwhile.`]);
    await waitFor((s) => s === 'running', 30_000);
    await sleep(6000);
    const out = dm(['--text', `Smoke token STEER-${tag}. Note it and carry on.`]);
    assert(out.status === 'steered' && out.recipientStatus === 'running', JSON.stringify(out));
    await sleep(3000);
    await waitFor((s) => s === 'idle', 240_000);
    const text = logs(a.id);
    const at = text.indexOf(`[User] [dm ${out.id}`);
    assert(at > 0, 'DM not in timeline');
    const before = text.slice(text.indexOf(`Smoke ${tag}: run`), at);
    const after = text.slice(at);
    assert(/\[Shell\][^\n]*S1-/.test(before), 'DM did not arrive after the first tool call');
    assert(/\[Shell\][^\n]*S2-/.test(after), 'turn did not continue with the second tool call (aborted?)');
    assert(after.includes(`DONE-${tag}`), 'task did not finish');
  });

  await check('daemon drops a repeated messageId; rejects it with different text', async () => {
    const a = await waitFor((s) => s === 'idle', 120_000);
    const { ulid } = await import('../bot-dm/cli.ts');
    const id = ulid();
    const text = `[dm ${id} from worker:bot-dm-smoke to ${to} kind=report hop=1 re=-]\nSmoke ${tag}: dedupe probe, reply OK.`;
    await paseo.send(a.id, text, { messageId: id, activeTurnBehavior: 'steer' });
    await paseo.send(a.id, text, { messageId: id, activeTurnBehavior: 'steer' });
    let conflict = null;
    try {
      await paseo.send(a.id, `${text} changed`, { messageId: id, activeTurnBehavior: 'steer' });
    } catch (error) {
      conflict = String(error?.message ?? error);
    }
    await sleep(3000);
    await waitFor((s) => s === 'idle', 180_000);
    const count = logs(a.id).split(`[User] [dm ${id}`).length - 1;
    assert(count === 1, `message appears ${count} times`);
    assert(conflict, 'different text under the same messageId was accepted');
    return `conflict error: ${conflict.slice(0, 80)}`;
  });
}

await paseo?.close().catch(() => {});
console.log(failed ? `${failed} check(s) failed` : `all checks passed (Paseo CLI ${version})`);
process.exit(failed ? 1 : 0);
