#!/usr/bin/env node
// Summarise the daemon's hourly WebSocket traffic counts.
//
//   node scripts/traffic-usage.mjs [--since 7d|36h|2026-11-20[T10:00Z]] [--home DIR] [--channel C] [--json]
//
// Reads $PASEO_HOME/runtime-metrics/traffic.1.jsonl and traffic.jsonl (written by
// packages/server/src/server/websocket/traffic-counts.ts, one line per hour and one more when the
// daemon stops). --home defaults to $PASEO_HOME, then ~/.paseo. A window counts when it ends
// after --since, so the first window can start up to an hour before it.
//
// Channels: in (top-level frames), inSession (session requests), out, outSession, outStream
// (agent_stream events), outBinary.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";

export const CHANNELS = ["in", "inSession", "out", "outSession", "outStream", "outBinary"];

export function defaultHome(env = process.env) {
  const raw = env.PASEO_HOME ?? "~/.paseo";
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

/** "7d", "36h", "90m" (before now) or anything Date.parse accepts. Returns ms since epoch. */
export function parseSince(value, now = Date.now()) {
  if (value === undefined) return 0;
  const rel = /^(\d+(?:\.\d+)?)([dhm])$/.exec(value);
  if (rel) return now - Number(rel[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2]];
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`--since: not a duration (7d, 36h) or a date: ${value}`);
  return at;
}

export function readWindows(home) {
  const dir = path.join(home, "runtime-metrics");
  const windows = [];
  for (const name of ["traffic.1.jsonl", "traffic.jsonl"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const w = JSON.parse(line);
        if (w && w.v === 1 && typeof w.from === "string" && typeof w.to === "string")
          windows.push(w);
      } catch {
        // a line cut short by a crash mid-write
      }
    }
  }
  return windows.sort((a, b) => a.to.localeCompare(b.to));
}

/** Totals per channel and type for windows ending after `since`. */
export function summarise(windows, since = 0) {
  const kept = windows.filter((w) => Date.parse(w.to) > since);
  const types = new Map(); // "channel:type" -> { channel, type, count, windows, last }
  let coveredMs = 0;
  for (const w of kept) {
    coveredMs += Math.max(0, Date.parse(w.to) - Date.parse(w.from));
    for (const channel of CHANNELS) {
      for (const [type, count] of Object.entries(w[channel] ?? {})) {
        if (!(count > 0)) continue;
        const key = `${channel}:${type}`;
        const t = types.get(key) ?? { channel, type, count: 0, windows: 0, last: w.to };
        t.count += count;
        t.windows += 1;
        if (w.to > t.last) t.last = w.to;
        types.set(key, t);
      }
    }
  }
  return {
    from: kept[0]?.from ?? null,
    to: kept.at(-1)?.to ?? null,
    windows: kept.length,
    stops: kept.filter((w) => w.final).length,
    coveredHours: Math.round((coveredMs / 3_600_000) * 10) / 10,
    types: [...types.values()].sort(
      (a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel) || b.count - a.count,
    ),
  };
}

export function coverageLine(s) {
  if (s.windows === 0) return "no traffic windows in range";
  return `${s.from} → ${s.to}: ${s.windows} windows, ${s.coveredHours} h covered, ${s.stops} daemon stops`;
}

export function parseArgs(argv, flags) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (flags.bool.includes(a)) out[a.slice(2)] = true;
    else if (flags.value.includes(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = argv[(i += 1)];
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

export function printHelp(url) {
  const lines = readFileSync(new URL(url), "utf8").split("\n").slice(1);
  const end = lines.findIndex((l) => !l.startsWith("//"));
  console.log(
    lines
      .slice(0, end)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    bool: ["--json"],
    value: ["--since", "--home", "--channel"],
  });
  if (args.help) return printHelp(import.meta.url);
  if (args.channel && !CHANNELS.includes(args.channel)) {
    throw new Error(`--channel must be one of ${CHANNELS.join(", ")}`);
  }
  const home = args.home ? path.resolve(args.home) : defaultHome();
  const s = summarise(readWindows(home), parseSince(args.since));
  if (args.channel) s.types = s.types.filter((t) => t.channel === args.channel);
  if (args.json) return console.log(JSON.stringify(s, null, 1));
  console.log(coverageLine(s));
  if (s.windows === 0) {
    console.log(`(read ${path.join(home, "runtime-metrics")})`);
    return;
  }
  const w = Math.max(4, ...s.types.map((t) => t.channel.length + t.type.length + 1));
  console.log(
    `${"channel:type".padEnd(w)}  ${"count".padStart(9)}  ${"wins".padStart(5)}  last window end`,
  );
  for (const t of s.types) {
    console.log(
      `${`${t.channel}:${t.type}`.padEnd(w)}  ${String(t.count).padStart(9)}  ${String(t.windows).padStart(5)}  ${t.last}`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`traffic-usage: ${error.message}`);
    process.exit(2);
  }
}
