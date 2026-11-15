#!/usr/bin/env node
// Status line for a Claude Code worker (launch.sh --engine cc), wired in the worker's settings.json (launch.sh
// writes it into <brief without .md>.cc/):
//
//   node cc-status.mjs <dir>   reads Claude Code's status JSON on stdin, keeps the session's spend
//                              (cost.total_cost_usd, Claude Code's own figure at API prices, subagents included) in
//                              <dir>/cost.json and prints "$<spent> · <model>", or "$<spent> / budget $<n> · <model>"
//                              when <dir>/budget holds a figure.
//
// Advisory, as for pi workers: nothing here blocks a tool call. The bot reads the spend from the pane and stops the
// worker at its budget (SKILL.md, section 5).
// Claude Code's figure restarts at 0 when the process restarts (a resumed worker, a relaunched bot): cost.json keeps
// each process's figure as a run (its session and start, now minus total_duration_ms), so the total only grows, and
// a status line that runs late with an older, lower figure changes nothing (each run keeps its highest).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const [dir] = process.argv.slice(2);
if (!dir) {
  process.stderr.write('usage: cc-status.mjs <dir>\n');
  process.exit(64);
}
const readJson = (f, d) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const budgetOf = (d) => {
  try {
    const n = Number(readFileSync(join(d, 'budget'), 'utf8').trim());
    return n > 0 ? n : null;
  } catch {
    return null;
  }
};
const money = (n) => `$${n.toFixed(2)}`;
const COST = join(dir, 'cost.json');

const s = (() => {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
})();
const now = Number(s?.cost?.total_cost_usd);
const c = readJson(COST, { base: 0, runs: [] });
if (!Array.isArray(c.runs)) {
  // A cost.json from before runs: its `last` is this process's when the session goes on and the figure grew.
  const last = Number(c.last) || 0;
  const same = c.session && c.session === s.session_id && Number.isFinite(now) && now >= last;
  c.base = (Number(c.base) || 0) + (same ? 0 : last);
  c.runs = [];
  delete c.last;
}
if (Number.isFinite(now)) {
  const dur = Number(s?.cost?.total_duration_ms);
  const start = Number.isFinite(dur) ? Date.now() - dur : null;
  const session = s.session_id ?? null;
  let run = c.runs.find((r) => r.session === session && (start === null || r.start === null || Math.abs(r.start - start) < 5000));
  if (!run) c.runs.push((run = { session, start, usd: 0 }));
  run.usd = Math.max(Number(run.usd) || 0, now);
  c.session = session;
  c.at = new Date().toISOString();
  try {
    writeFileSync(COST + '.tmp', JSON.stringify(c) + '\n');
    renameSync(COST + '.tmp', COST);
  } catch {
    // the status line still shows the figure
  }
}
const spent = (Number(c.base) || 0) + c.runs.reduce((a, r) => a + (Number(r.usd) || 0), 0);
const budget = budgetOf(dir);
const over = budget !== null && spent >= budget ? ' OVER BUDGET' : '';
process.stdout.write(`${money(spent)}${budget !== null ? ` / budget ${money(budget)}` : ''}${over} · ${s?.model?.display_name ?? ''}`.replace(/ · $/, ''));
