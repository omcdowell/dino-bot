/**
 * Onboarding auto-import from the command line (the setup wizard and the daemon call these):
 *
 *   tsx src/import/cli.ts scan  [--home DIR] [--subscription S] [--untick PROJECT]... [--json]
 *       Finds every local agent history, reads it, and prints projects, counts, the estimate and the warning.
 *       Reads only; sends nothing to any model.
 *   tsx src/import/cli.ts start <profile> [--home DIR] [--untick PROJECT]...
 *       Stages a background import into the profile (no model calls).
 *   tsx src/import/cli.ts run <profile> [--force]
 *       Builds the staged import with the profile's import compactor until done, Ctrl-C (pause) or a rate limit.
 *       Run it again to resume. The bot finishes the swap itself (/optchat import → Finish background import).
 *   tsx src/import/cli.ts status <profile> | discard <profile>
 */
import { homedir } from 'node:os';
import { appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discover, readDiscovered, NOT_SUPPORTED, type Discovery } from './discover.ts';
import { estimate, warning } from './estimate.ts';
import { MODEL_DEFAULTS, SUBSCRIPTIONS, importModelFor, type Subscription, type Defaults } from '../model-defaults.ts';
import { backgroundDir, backgroundState, discardBackground, runBackground, startBackground } from './auto.ts';
import { loadConfig, profilePath } from '../profiles.ts';

function options(args: string[]) {
  const o = {
    home: homedir(),
    subscription: 'claude-max' as Subscription,
    untick: [] as string[],
    json: false,
    force: false,
    rest: [] as string[],
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--home') o.home = resolve(args[++k]);
    else if (a === '--subscription') {
      const s = args[++k] as Subscription;
      if (!SUBSCRIPTIONS.includes(s)) throw new Error(`--subscription: one of ${SUBSCRIPTIONS.join(', ')}`);
      o.subscription = s;
    } else if (a === '--untick') o.untick.push(args[++k]);
    else if (a === '--json') o.json = true;
    else if (a === '--force') o.force = true;
    else o.rest.push(a);
  }
  return o;
}
const ticked = (found: Discovery, untick: string[]) =>
  found.projects.filter(p => p.ticked && !untick.includes(p.project)).map(p => p.project);
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

export async function scan(args: string[]) {
  const o = options(args);
  const t0 = Date.now();
  const found = await discover(o.home);
  const t1 = Date.now();
  const read = await readDiscovered(found, ticked(found, o.untick));
  const t2 = Date.now();
  const row: Defaults = MODEL_DEFAULTS[o.subscription];
  const e = estimate(read.sizes, row.importPrice, row.weeklyUsd);
  const perSubscription = Object.fromEntries(
    SUBSCRIPTIONS.map(s => {
      const r: Defaults = MODEL_DEFAULTS[s];
      const x = estimate(read.sizes, r.importPrice, r.weeklyUsd);
      return [s, { model: `${r.importCompaction.provider}/${r.importCompaction.model}`, usd: x.usd?.mid, weeklyShare: x.weeklyShare }];
    }),
  );
  const result = {
    home: o.home,
    sources: found.sources,
    notSupported: NOT_SUPPORTED.filter(n => existsSync(n.path.replace(/^~/, o.home).replace(/\/\*.*$/, ''))),
    projects: found.projects.map(p => ({ ...p, ticked: p.ticked && !o.untick.includes(p.project), ...read.perProject.get(p.project) })),
    messages: read.entries.length,
    textBytes: read.bytes,
    estimate: e,
    perSubscription,
    warning: warning(e, row),
    warnings: read.warnings.length,
    timing: { discoverMs: t1 - t0, readMs: t2 - t1 },
  };
  if (o.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`Sources under ${o.home}:`);
  for (const s of found.sources) console.log(`  ${s.label}: ${s.conversations} conversations, ${mb(s.bytes)} of logs`);
  for (const n of result.notSupported) console.log(`  ${n.name}: found, not read (${n.why})`);
  console.log(`Projects (${found.projects.length}; unticked by default: ${found.projects.filter(p => !p.ticked).length} throwaway):`);
  for (const p of result.projects.slice(0, 15))
    console.log(`  [${p.ticked ? 'x' : ' '}] ${p.project}  ${p.conversations} conv · ${p.messages ?? 0} msgs`);
  if (result.projects.length > 15) console.log(`  … ${result.projects.length - 15} more`);
  console.log(`\n${result.messages} messages to import, ${mb(read.bytes)} text. Read in ${((t2 - t0) / 1000).toFixed(1)} s.`);
  console.log(`\n${result.warning}`);
}

export async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === 'scan') return scan(rest);
  const o = options(rest);
  const [profile] = o.rest;
  if (!profile || !['start', 'run', 'status', 'discard'].includes(command ?? ''))
    throw new Error('Usage: see the header of src/import/cli.ts');
  const dir = profilePath(profile);
  if (!existsSync(join(dir, 'config.json'))) throw new Error(`No profile ${profile}.`);
  if (command === 'status') return console.log(JSON.stringify(backgroundState(dir) ?? null, null, 2));
  if (command === 'discard') return discardBackground(dir);
  if (command === 'start') {
    const found = await discover(o.home);
    const read = await readDiscovered(found, ticked(found, o.untick));
    const state = startBackground(dir, read.entries);
    return console.log(state ? `Staged ${read.entries.length} messages for ${profile}.` : 'Nothing new to import.');
  }
  // run: the model registry and sign-ins come from pi's own auth.json, as for the bots.
  const { ModelRegistry, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { createCompressor } = await import('../compactor.ts');
  const registry = new ModelRegistry(await ModelRuntime.create());
  const config = loadConfig(dir);
  const model = importModelFor(config);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const progress = (p: { messages: number; total: number; summaries: number; error?: string }) =>
    process.stderr.write(`\r${p.messages}/${p.total} messages · ${p.summaries} summaries${p.error ? ' · ' + p.error.slice(0, 60) : ''}   `);
  const usage = join(backgroundDir(dir), 'usage.jsonl');
  const compress = createCompressor(
    registry,
    () => model,
    message => appendFileSync(usage, JSON.stringify({ date: new Date().toISOString(), model: message.model, usage: message.usage }) + '\n'),
  );
  const outcome = await runBackground(dir, compress, controller.signal, progress, { force: o.force });
  console.log(`\n${JSON.stringify(outcome)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
