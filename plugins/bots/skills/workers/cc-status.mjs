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
// Claude Code's figure restarts at 0 when the process restarts (a resumed worker): cost.json keeps what earlier
// processes spent in `base`, so the total only grows.
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
const c = readJson(COST, { base: 0, last: 0 });
if (Number.isFinite(now)) {
  // A new Claude Code process (resume) starts its figure at 0 again: bank the old one.
  if (now < (Number(c.last) || 0)) c.base = (Number(c.base) || 0) + (Number(c.last) || 0);
  c.last = now;
  c.session = s.session_id ?? c.session ?? null;
  c.at = new Date().toISOString();
  try {
    writeFileSync(COST + '.tmp', JSON.stringify(c) + '\n');
    renameSync(COST + '.tmp', COST);
  } catch {
    // the status line still shows the figure
  }
}
const spent = (Number(c.base) || 0) + (Number(c.last) || 0);
const budget = budgetOf(dir);
const over = budget !== null && spent >= budget ? ' OVER BUDGET' : '';
process.stdout.write(`${money(spent)}${budget !== null ? ` / budget ${money(budget)}` : ''}${over} · ${s?.model?.display_name ?? ''}`.replace(/ · $/, ''));
