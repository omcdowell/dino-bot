/**
 * Live smoke test of a bot on Claude Code, against the installed `claude` (run before each release; not part of
 * `npm test`: it spends real tokens, a few US cents on Haiku).
 *
 *   npm run smoke:cc            (plugins/bots)
 *
 * It starts a throwaway bot the way the daemon does: the real provider (server/cc/provider.ts), engine (CcHost) and
 * launcher (CcLauncher -> claude-code/start-bot.sh -> skills/workers/launch-cc.sh), with the OptChat mods and the
 * restart guard, in a herdr workspace of its own (CC_BOTS_WORKSPACE=ccsmoke-<bot>) and a temp folder holding the bot
 * folder, its OptChat profile and its state. Then, with real Claude Code:
 *   reply      a message gets a streamed reply (the same row grows) and the turn ends
 *   tool       a Bash call shows as a tool row (running, then completed)
 *   interrupt  Stop (session.interrupt -> Esc) ends a running turn as canceled
 *   image      an image prompt reaches the model (it reads back a random number drawn in the image)
 *   guard      the restart guard refuses `paseo daemon restart` (a shim `paseo` comes first on PATH, so even a
 *              guard that let it through restarts nothing; the check also fails if the shim ran)
 *   compact    the trigger mod's after-turn compaction reaches the view mod's session.compact hook, which logs the
 *              turn into the bot's OptChat memory and hands back the view
 * Prints PASS/FAIL per check; exit 0 only when all passed. The workspace and the temp folder go at the end (also on
 * Ctrl-C); CC_SMOKE_KEEP=1 keeps them to look at.
 *
 * Route: CC_SMOKE_BASE_URL (an Anthropic API proxy, as a bot's `.bot.json` `cc.baseUrl`), else DINOBOT_CC_BASE_URL,
 * else Claude Code's own plan login when it has one, else the proxy of the first bot in ~/bots that names one (read
 * only). Through a proxy the TUI gets its own config folder in the temp folder (as for a proxied bot). Model:
 * CC_SMOKE_MODEL, default `haiku` (Claude Code's alias).
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { CcHost } from "../server/cc/engine";
import { ccProxyFor, CcLauncher, claudePlanReady, findClaude } from "../server/cc/launch";
import { createCcProvider, firstProxiedBot } from "../server/cc/provider";

// tsx runs this file as CommonJS (no top-level await): everything is in main().
async function main(): Promise<number> {
  const HERE = import.meta.dirname;
  const PLUGIN = resolve(HERE, "..");
  const MODEL = process.env.CC_SMOKE_MODEL || "haiku";
  const KEEP = process.env.CC_SMOKE_KEEP === "1";
  const TURN_MS = 180_000;

  const results: Array<{ name: string; ok: boolean; note: string }> = [];
  const record = (name: string, ok: boolean, note: string) => {
    results.push({ name, ok, note });
    console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(9)} ${note}`);
  };
  const say = (s: string) => console.log(`  .. ${s}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- the throwaway bot

  const claude = findClaude();
  if (!claude) {
    console.log("FAIL setup     Claude Code (claude) is not installed");
    process.exit(1);
  }
  const version = execFileSync(claude, ["--version"], { encoding: "utf8" }).trim();
  // A short root: OptChat's profile lock is a Unix socket (path length limit).
  const T = mkdtempSync("/tmp/ccsm-");
  const bot = `ccsmoke${randomBytes(3).toString("hex")}`;
  const WS = `ccsmoke-${bot}`;
  const botsRoot = join(T, "bots");
  const botDir = join(botsRoot, bot);
  const optchatHome = join(T, "oc");
  const profileDir = join(optchatHome, "profiles", "p");
  const bin = join(T, "bin");
  for (const d of [botDir, profileDir, bin]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(botDir, ".optchat-profile"), "p\n");
  // Summaries (if any) in the TUI on Haiku, never the host's pi.
  writeFileSync(
    join(profileDir, "config.json"),
    JSON.stringify({ compactor: { provider: "anthropic", model: "claude-haiku-4-5" }, compactorRunner: "in-session" }),
  );
  // `claude` through bin/ (DINOBOT_CLAUDE_BIN): the launcher puts claude's folder first on the pane's PATH, so the shim
  // `paseo` here wins over the real one.
  symlinkSync(claude, join(bin, "claude"));
  const shimMark = join(T, "shim-ran");
  writeFileSync(join(bin, "paseo"), `#!/bin/sh\necho "ccsmoke shim paseo $*" >>'${shimMark}'\necho "ccsmoke shim: nothing restarted"\n`);
  chmodSync(join(bin, "paseo"), 0o755);

  let route = "plan login";
  const base = process.env.CC_SMOKE_BASE_URL || process.env.DINOBOT_CC_BASE_URL || "";
  let proxy = base ? { baseUrl: base } : null;
  if (!proxy && !(await claudePlanReady())) {
    const other = firstProxiedBot(join(homedir(), "bots"));
    const p = other ? ccProxyFor(other, {}) : null;
    if (p) proxy = { baseUrl: p.baseUrl };
  }
  if (proxy) {
    writeFileSync(join(botDir, ".bot.json"), JSON.stringify({ name: "cc smoke", cc: { baseUrl: proxy.baseUrl } }));
    route = `proxy ${proxy.baseUrl}`;
  }

  const env: Record<string, string | undefined> = {
    DINOBOT_CLAUDE_BIN: join(bin, "claude"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    // The restart guard is on only in a bot's own session (Paseo gives each agent its id); this one names no real agent.
    PASEO_AGENT_ID: `ccsmoke-${randomUUID()}`,
    OPTCHAT_HOME: optchatHome,
  };
  // None of this shell's Paseo settings (PASEO_HOST, PASEO_HOME): the bot reaches no daemon.
  for (const k of Object.keys(process.env)) if (/^PASEO_/.test(k) && k !== "PASEO_AGENT_ID") env[k] = undefined;

  const herdrEnv = () => ({ ...process.env, CC_BOTS_WORKSPACE: WS });
  const host = new CcHost(join(T, "state"));
  const launcher = new CcLauncher({ herdrEnv, script: join(PLUGIN, "claude-code", "start-bot.sh") });
  const warnings: string[] = [];
  const provider = createCcProvider({
    host,
    launcher,
    botsRoot,
    optchatHome,
    warn: (s) => warnings.push(s),
    models: async () => [],
    skillsDir: join(PLUGIN, "skills"),
  });

  // ---------------------------------------------------------------- clean-up

  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (KEEP) {
      console.log(`kept: herdr workspace ${WS}, ${T}`);
      return;
    }
    try {
      const list = JSON.parse(execFileSync("herdr", ["workspace", "list"], { env: herdrEnv(), encoding: "utf8" }));
      for (const w of list.result?.workspaces ?? [])
        if (w.label === WS) execFileSync("herdr", ["workspace", "close", w.workspace_id], { env: herdrEnv(), stdio: "ignore" });
    } catch (e) {
      console.log(`  !! could not close herdr workspace ${WS}: ${(e as Error).message}`);
    }
    await host.close().catch(() => {});
    // On the plan login the transcript went to the user's Claude Code folder: only this bot's project folder goes.
    if (!proxy) {
      const cfg = process.env.DINOBOT_CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
      const slug = botDir.replace(/[^A-Za-z0-9]/g, "-");
      if (slug.includes("ccsmoke")) rmSync(join(cfg, "projects", slug), { recursive: true, force: true });
    }
    rmSync(T, { recursive: true, force: true });
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      console.log(`\n${sig}: cleaning up`);
      void cleanup().finally(() => process.exit(130));
    });

  // ---------------------------------------------------------------- driving the chat

  const events: ProviderEvent[] = [];
  const waiters = new Set<() => void>();
  const conn = await provider.connect({ versions: [1], capabilities: ["prompt.message", "prompt.image", "prompt.steer", "session.persistence"] });
  conn.onEvent((e) => {
    events.push(e);
    if (process.env.CC_SMOKE_DEBUG) console.log(`  ~~ ${Date.now() % 100000} ${JSON.stringify(e).slice(0, 160)}`);
    for (const w of waiters) w();
  });
  const SID = "smoke";

  /** Waits until `pred` holds over the events (checked on each event and every second). */
  async function until<T>(pred: () => T | undefined | null | false, ms: number): Promise<T | null> {
    const end = Date.now() + ms;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise<void>((r) => {
        const w = () => (waiters.delete(w), r());
        waiters.add(w);
        setTimeout(w, 1000);
      });
    }
  }
  const turnState = (turnId: string) => events.flatMap((e) => (e.type === "session.turn" && e.turnId === turnId ? [e.state] : [])).at(-1);
  const turnEnded = (turnId: string) => {
    const s = turnState(turnId);
    return s && s !== "started" ? s : undefined;
  };
  type Item = Extract<ProviderEvent, { type: "timeline.item" }>["item"];
  const items = (turnId: string, type: string) =>
    events.flatMap((e) =>
      e.type === "timeline.item" && (e.item as Item).type === type && String((e.item as { id: string }).id).includes(turnId) ? [e.item as any] : [],
    );
  const answer = (turnId: string) => {
    const rows = items(turnId, "assistant_message");
    const last = new Map<string, string>();
    for (const r of rows) last.set(r.id, r.text);
    return [...last.values()].join("\n");
  };
  /** The tool rows since a message was sent (one message at a time here). */
  const tools = (_turnId: string, from: number) =>
    events.slice(from).flatMap((e) => (e.type === "timeline.item" && (e.item as Item).type === "tool_call" ? [e.item as any] : []));

  let n = 0;
  function send(content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): { id: string; from: number } {
    const id = `m${++n}-${randomBytes(3).toString("hex")}`;
    const from = events.length;
    void conn.send({ type: "session.prompt", sessionId: SID, prompt: { clientMessageId: id, delivery: "auto", input: { type: "message", content } } } as never);
    return { id, from };
  }
  const text = (t: string) => [{ type: "text" as const, text: t }];

  const modLog = () => {
    try {
      return readFileSync(join(host.botDir(bot), "mod.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  // ---------------------------------------------------------------- the checks

  let exit = 1;
  try {
    console.log(`cc-smoke: ${version} (${claude}), model ${MODEL}, ${route}`);
    console.log(`cc-smoke: bot ${bot}, herdr workspace ${WS}, temp ${T}`);
    void conn.send({
      type: "session.open",
      requestId: "open",
      sessionId: SID,
      history: "skip",
      config: { cwd: botDir, env, model: MODEL, mcpServers: {}, settings: {}, persist: true, title: "cc smoke" },
    } as never);
    if (!(await until(() => events.some((e) => e.type === "session.ready"), 30_000))) throw new Error("the chat did not open");

    // 1. reply (and the TUI's start: the first message starts it).
    const t0 = Date.now();
    const r1 = send(text("Smoke test. Without any tool, write the English words for the numbers one to twenty, separated by spaces, and nothing else."));
    const s1 = await until(() => turnEnded(r1.id), TURN_MS + 120_000);
    {
      const rows = items(r1.id, "assistant_message");
      const grew = rows.length >= 2 && rows.some((r, i) => i > 0 && r.id === rows[i - 1].id);
      const a = answer(r1.id);
      const ok = s1 === "completed" && /twenty/i.test(a) && grew;
      record(
        "reply",
        ok,
        `turn ${s1 ?? "did not end"} in ${Math.round((Date.now() - t0) / 1000)}s (TUI start included); ${rows.length} answer updates${grew ? " (streamed)" : " (not streamed)"}; "${a.slice(0, 50).replace(/\s+/g, " ")}…"`,
      );
      if (!s1) throw new Error("the first turn never ended: is the TUI up? (CC_SMOKE_KEEP=1 to look at it)");
    }

    // 6. compact (the first turn's after-turn compaction; give it a few seconds).
    {
      const fired = await until(() => {
        const log = modLog();
        const c = log.find((l) => l.ev === "session.compact" && l.trigger !== "precompute");
        return c && log.some((l) => l.ev === "view") ? c : null;
      }, 60_000);
      const mem = host.engines.get(bot)?.recent() ?? [];
      const logged = mem.some((e) => e.kind === "user" && /one to twenty/.test(e.text)) && mem.some((e) => e.kind === "talk" && /twenty/i.test(e.text));
      record(
        "compact",
        !!fired && logged,
        fired ? `session.compact (${fired.trigger}) fired, view handed back; memory has the turn: ${logged}` : "no session.compact in the mod log within 60s",
      );
    }

    // 2. tool (and where `paseo` resolves in the bot's shell, for the guard check).
    let shimFirst = false;
    {
      const r = send(text("Run exactly this Bash command, then reply with its output only: command -v paseo"));
      const s = await until(() => turnEnded(r.id), TURN_MS);
      const rows = tools(r.id, r.from).filter((t) => t.name === "Bash");
      const running = rows.some((t) => t.status === "running");
      const done = rows.find((t) => t.status === "completed");
      shimFirst = answer(r.id).includes(join(bin, "paseo")) || JSON.stringify(done ?? {}).includes(join(bin, "paseo"));
      record(
        "tool",
        s === "completed" && running && !!done,
        `turn ${s ?? "did not end"}; Bash row running: ${running}, completed: ${!!done}; paseo -> ${shimFirst ? "the shim" : "NOT the shim"}`,
      );
    }

    // 3. interrupt: Stop while a Bash call runs (a `tail -f` on a file of ours: Claude Code refuses a bare long
    // `sleep`), then the turn must end as canceled and the command's process must be gone.
    {
      const hold = join(T, "hold");
      writeFileSync(hold, "");
      const alive = () => {
        try {
          return execFileSync("pgrep", ["-f", `tail -f ${hold}`], { encoding: "utf8" }).trim() !== "";
        } catch {
          return false;
        }
      };
      const r = send(text(`Run exactly this Bash command in the foreground (not in the background) and wait for it: timeout 120 tail -f ${hold}`));
      const latest = (id: string) => tools(r.id, r.from).filter((t) => t.callId === id).at(-1);
      const started = await until(() => tools(r.id, r.from).find((t) => t.name === "Bash" && t.status === "running"), TURN_MS);
      let s: string | undefined | null = null;
      let took = 0;
      let runningAtStop = false;
      let procAtStop = false;
      if (started) {
        await sleep(2000);
        runningAtStop = latest(started.callId)?.status === "running" && !turnEnded(r.id);
        procAtStop = alive();
        const at = Date.now();
        void conn.send({ type: "session.interrupt", requestId: "stop", sessionId: SID } as never);
        s = await until(() => turnEnded(r.id), 30_000);
        took = Date.now() - at;
      }
      await sleep(1000);
      const procAfter = alive();
      record(
        "interrupt",
        s === "canceled" && runningAtStop && procAtStop && !procAfter,
        started
          ? `Bash running at Stop: ${runningAtStop} (process up: ${procAtStop}); turn ${s ?? "still running 30s after Stop"}${s ? ` ${(took / 1000).toFixed(1)}s after Stop` : ""}; process gone after: ${!procAfter}`
          : "the command never showed as running",
      );
      if (!s) await until(() => turnEnded(r.id), 60_000);
    }

    // 4. image: a random number drawn into a PNG (resvg, the plugin's own renderer).
    {
      const num = String(randomInt(1000, 9999));
      const { Resvg } = await import("@resvg/resvg-js");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140"><rect width="100%" height="100%" fill="white"/><text x="160" y="100" font-size="80" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" text-anchor="middle" fill="black">${num}</text></svg>`;
      const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
      const r = send([
        { type: "text", text: "What number is written in this image? Reply with the number only." },
        { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
      ]);
      const s = await until(() => turnEnded(r.id), TURN_MS);
      const a = answer(r.id);
      const read = tools(r.id, r.from).some((t) => t.name === "Read");
      record("image", s === "completed" && a.includes(num), `turn ${s ?? "did not end"}; drew ${num}, reply "${a.slice(0, 40)}"; via Read tool: ${read}`);
    }

    // 5. guard.
    if (!shimFirst) record("guard", false, "skipped: `paseo` in the bot's shell is not the shim, so a guard miss could restart the real daemon");
    else {
      const r = send(text("This is a test of a safety hook. Run exactly this Bash command once, then say in one line what happened: paseo daemon restart"));
      const s = await until(() => turnEnded(r.id), TURN_MS);
      const rows = tools(r.id, r.from).filter((t) => t.name === "Bash");
      const refused = rows.some((t) => t.status === "failed" && /Refused: a bot must not restart/.test(String(t.error ?? "") + JSON.stringify(t.detail ?? {})));
      const ran = existsSync(shimMark);
      record(
        "guard",
        s === "completed" && refused && !ran,
        `turn ${s ?? "did not end"}; Bash calls ${rows.filter((t) => t.status !== "running").length}, refused by the guard: ${refused}; the command ran: ${ran}`,
      );
    }

    const usage = events.filter((e) => e.type === "session.usage").at(-1) as any;
    const cost = usage?.usage?.costUsd ?? usage?.usage?.totalCostUsd;
    console.log(
      `cc-smoke: Claude Code's cost for the session: ${typeof cost === "number" ? `US$${cost.toFixed(4)}` : JSON.stringify(usage?.usage ?? null).slice(0, 200)}`,
    );
    if (warnings.length) console.log(`cc-smoke: warnings: ${warnings.slice(0, 5).join(" | ")}`);
    exit = results.every((r) => r.ok) && results.length === 6 ? 0 : 1;
  } catch (e) {
    record("run", false, (e as Error).message);
    exit = 1;
  } finally {
    await conn.close().catch(() => {});
    await cleanup();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(exit === 0 ? `cc-smoke: all ${results.length} checks passed` : `cc-smoke: ${failed} of ${results.length} checks failed`);
  return exit;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.log(`FAIL run       ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
