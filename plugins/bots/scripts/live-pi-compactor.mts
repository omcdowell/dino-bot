// Live proof for FF1 (not a test): a throwaway Claude Code bot profile whose summaries run on the host's real pi.
// Usage: tsx scripts/live-pi-compactor.mts <scratch dir> <provider/model> <thinking> [piAgentDir]
// With piAgentDir pointing at an empty folder pi is "not signed in": the summary falls back in-session, which this
// script plays over the engine's HTTP routes exactly as the inbox mod does (GET /jobs, POST /job).
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CcHost } from "../server/cc/engine.ts";

const [base, ref, thinking, piAgentDir] = process.argv.slice(2);
const slash = ref!.indexOf("/");
const compactor = { provider: ref!.slice(0, slash), model: ref!.slice(slash + 1), thinking };
const profile = join(base!, "profile");
rmSync(base!, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, "config.json"), JSON.stringify({ compactor, subagent: compactor }, null, 2));
if (piAgentDir) process.env.PI_CODING_AGENT_DIR = piAgentDir;
const host = new CcHost(join(base!, "state"));
const engine = await host.engine("live-pi", profile, { warn: (s) => console.log("WARN", s) });
const conn = JSON.parse(readFileSync(join(base!, "state", "live-pi", "engine.json"), "utf8"));
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(conn.url + path, { method, headers: { authorization: `Bearer ${conn.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json() as Promise<any>;
};
// The "in-session" side, played as the mod does it (only fallback jobs ever arrive here).
let inSessionJobs = 0;
const mod = setInterval(async () => {
  const { jobs } = await call("GET", "/jobs?max=4");
  for (const j of jobs ?? []) {
    inSessionJobs++;
    await call("POST", "/job", { id: j.id, text: `in-session stand-in summary (${j.model})`, usage: { input_tokens: 0, output_tokens: 0 }, model: j.model });
  }
}, 500);
await call("POST", "/hello", {});
await call("POST", "/append", {
  messages: [
    { kind: "user", text: "Can you plan a three-day trip to Kyoto in late November for two people who love temples, gardens and quiet food spots? ".repeat(6) },
    { kind: "talk", text: "Day 1: Higashiyama — Kiyomizu-dera at opening, Sannenzaka, Kodai-ji; lunch at a yudofu place near Nanzen-ji; evening Gion walk. Day 2: Arashiyama bamboo grove early, Tenryu-ji garden, Okochi Sanso; afternoon Kinkaku-ji and Ryoan-ji. Day 3: Fushimi Inari at dawn, Tofuku-ji for autumn leaves, Nishiki market lunch. Book kaiseki ahead. ".repeat(3) },
  ],
});
const t0 = Date.now();
const view = await call("GET", "/view?settle=60000");
console.log("settled", view.settled, "in", Date.now() - t0, "ms; in-session jobs answered:", inSessionJobs);
console.log("VIEW\n" + String(view.view).slice(0, 1500));
console.log("STATUS", JSON.stringify((await call("GET", "/status")).compactor));
for (const f of ["compactor-usage.jsonl", "compactor-runner.jsonl", "compactor-errors.jsonl"]) {
  const p = join(profile, f);
  console.log(`--- ${f}`, existsSync(p) ? "\n" + readFileSync(p, "utf8").trim() : "(none)");
}
clearInterval(mod);
await host.close();
