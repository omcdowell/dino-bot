#!/usr/bin/env node
// Fail a cut list if any of its message types had WebSocket traffic.
//
//   node scripts/traffic-check.mjs <cut-list|-> [--since 7d|<date>] [--min-hours N] [--home DIR]
//
// The cut list has one type per line; `#` starts a comment. A bare name (`fetch_agents_request`)
// matches it on every channel; `inSession:fetch_agents_request` matches one channel (channels:
// see traffic-usage.mjs). Use --since with the time the current clients were installed.
//
// Exit 0: no listed type had traffic. Exit 1: some did (listed). Exit 2: usage error, no data, or
// less than --min-hours (default 24) of data in the range. Data comes from traffic-usage.mjs.
//
// A zero count only says the type was not seen while the daemon ran in that range: types sent on
// failure paths (a resync after an error) can be rare. Check those by reading the client.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";
import {
  CHANNELS,
  coverageLine,
  defaultHome,
  parseArgs,
  parseSince,
  printHelp,
  readWindows,
  summarise,
} from "./traffic-usage.mjs";

export function parseCutList(text) {
  const entries = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z]+):(.+)$/.exec(line);
    if (m && CHANNELS.includes(m[1])) entries.push({ channel: m[1], type: m[2].trim() });
    else entries.push({ channel: null, type: line });
  }
  return entries;
}

/** Live hits: one per listed type and channel with a count above zero. */
export function checkCutList(entries, summary) {
  const hits = [];
  for (const e of entries) {
    for (const t of summary.types) {
      if (t.type === e.type && (e.channel === null || e.channel === t.channel)) hits.push(t);
    }
  }
  return hits;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    bool: [],
    value: ["--since", "--home", "--min-hours"],
  });
  if (args.help) return (printHelp(import.meta.url), 0);
  if (args._.length !== 1) throw new Error("give one cut list file (or - for stdin)");
  const minHours = args["min-hours"] === undefined ? 24 : Number(args["min-hours"]);
  if (!(minHours >= 0)) throw new Error("--min-hours must be a number ≥ 0");
  const text = args._[0] === "-" ? readFileSync(0, "utf8") : readFileSync(args._[0], "utf8");
  const entries = parseCutList(text);
  if (entries.length === 0) throw new Error("the cut list is empty");
  const home = args.home ? path.resolve(args.home) : defaultHome();
  const summary = summarise(readWindows(home), parseSince(args.since));
  console.log(coverageLine(summary));
  if (summary.coveredHours < minHours) {
    console.error(
      `traffic-check: only ${summary.coveredHours} h of data (need ${minHours}; --min-hours to change) in ${path.join(home, "runtime-metrics")}`,
    );
    return 2;
  }
  const hits = checkCutList(entries, summary);
  if (hits.length === 0) {
    console.log(`ok: none of the ${entries.length} listed types had traffic`);
    return 0;
  }
  console.log(
    `FAIL: ${new Set(hits.map((h) => h.type)).size} of ${entries.length} listed types had traffic`,
  );
  for (const h of hits) {
    console.log(
      `  ${h.channel}:${h.type}  ${h.count} messages in ${h.windows} windows, last window ${h.last}`,
    );
  }
  return 1;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`traffic-check: ${error.message}`);
    process.exitCode = 2;
  }
}
