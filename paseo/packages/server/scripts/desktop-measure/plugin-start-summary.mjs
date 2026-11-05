#!/usr/bin/env node
// node plugin-start-summary.mjs before.jsonl [...]: one line per run (ms from page start).
import { readFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    if (!row.result) {
      console.log(row.label, row.run, "ERROR", row.error);
      continue;
    }
    const { sockets, frames, seen, marks } = row.result;
    const open = sockets[0]?.open;
    // Bytes in/out from socket open until the plugin rows show (the "connect" phase).
    const until = seen.pluginRows ?? Infinity;
    let inBytes = 0;
    let outBytes = 0;
    for (const [t, , n] of frames) {
      if (t > until + 50) break;
      if (n > 0) inBytes += n;
      else outBytes -= n;
    }
    // The catalog response is the first inbound frame over 15 KB that is not a 16422 B chunk.
    const catalog = frames.find(([, , n]) => n > 15000 && n !== 16422);
    const out = {
      label: row.label,
      run: row.run,
      wsCreated: Math.round(sockets[0]?.created ?? NaN),
      wsOpen: Math.round(open ?? NaN),
      catalogFrame: catalog ? `${Math.round(catalog[0])}ms/${catalog[2]}B` : "none",
      pluginItem: Math.round(seen.pluginItem ?? NaN),
      pluginRows: Math.round(seen.pluginRows ?? NaN),
      inBeforeRows: inBytes,
      outBeforeRows: outBytes,
      marks: Object.fromEntries((marks ?? []).map(([name, t]) => [name.replace("paseo:plugins:", ""), t])),
      cacheKeys: (row.pluginCacheKeys ?? []).map(([k, n]) => `${k.split(":").slice(0, 3).join(":")}=${n}`),
    };
    console.log(JSON.stringify(out));
  }
}
