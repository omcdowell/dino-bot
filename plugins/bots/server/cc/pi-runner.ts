/**
 * The pi compactor runner (FF1): one summary attempt answered by the host's `pi` CLI, on the host's own pi sign-in
 * (`~/.pi/agent`), with any model pi has. Print mode, JSON events, nothing else: no tools, session file, skills,
 * prompt templates, context files (AGENTS.md), MCP or themes. Installed packages still load so the providers they add
 * work. The view and task go on stdin (no argv size limit); the reply's last assistant message gives the line, its
 * usage and cost.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface PiRequest {
  provider: string;
  model: string;
  thinking: string;
  system: string;
  prompt: string;
  /** pi's working directory (it names it in the system prompt): the profile folder, so the prefix stays the same. */
  cwd: string;
}
/** usage: pi's own shape ({input, output, cacheRead, cacheWrite, totalTokens, cost: {…, total}}). */
export type PiResult = { text: string; usage?: unknown; model: string } | { error: string; status?: number };
export type PiRunner = (req: PiRequest, signal: AbortSignal) => Promise<PiResult>;

const TIMEOUT_MS = 5 * 60_000;

/** The `pi` binary: DINOBOT_PI_BIN, PATH, or the usual install places. */
export function findPi(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DINOBOT_PI_BIN) return env.DINOBOT_PI_BIN;
  const home = env.HOME ?? "";
  const dirs = [...String(env.PATH ?? "").split(delimiter), home && join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d) continue;
    try {
      if (statSync(join(d, "pi")).isFile()) return join(d, "pi");
    } catch {}
  }
  return null;
}

/** pi's --mode json output: the last assistant message's text and usage, or its error. */
export function parsePiJson(stdout: string): PiResult {
  let last: Record<string, any> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "message_end" && e.message?.role === "assistant") last = e.message;
    } catch {}
  }
  if (!last) return { error: "pi gave no answer" };
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    const error = String(last.errorMessage ?? `pi ${last.stopReason}`);
    const status = /\b(4\d\d|5\d\d)\b/.exec(error)?.[1];
    return { error, ...(status ? { status: Number(status) } : {}) };
  }
  const text = (Array.isArray(last.content) ? last.content : [])
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
  const model = [last.provider, last.model].filter((s) => typeof s === "string" && s).join("/");
  return { text, ...(last.usage !== undefined ? { usage: last.usage } : {}), model };
}

export interface PiRunnerOptions {
  /** The pi binary (default findPi()). */
  bin?: string;
  /** pi's environment (default the daemon's: the host's pi sign-in). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** A PiRunner that spawns pi once per attempt. Never throws for pi's failures (they are results); rejects on abort. */
export function spawnPiRunner(opts: PiRunnerOptions = {}): PiRunner {
  return (req, signal) =>
    new Promise<PiResult>((resolve, reject) => {
      const env = { ...(opts.env ?? process.env) };
      const bin = opts.bin ?? findPi(env);
      if (!bin) return resolve({ error: "pi is not installed on this computer (not found)" });
      // pi is a node script (#!/usr/bin/env node): the daemon's node goes first on PATH.
      env.PATH = [dirname(process.execPath), env.PATH ?? ""].filter(Boolean).join(delimiter);
      const args = [
        "-p",
        "--mode", "json",
        "--no-session",
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
        "--no-themes",
        "--no-approve",
        "--offline",
        "--model", `${req.provider}/${req.model}`,
        "--thinking", req.thinking,
        "--system-prompt", req.system,
      ];
      if (signal.aborted) return reject((signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted"));
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, { cwd: req.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        return resolve({ error: `pi could not start: ${(error as Error).message}` });
      }
      let out = "";
      let err = "";
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        fn();
      };
      const abort = () => {
        child.kill("SIGTERM");
        finish(() => reject((signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => resolve({ error: `pi timed out after ${Math.round((opts.timeoutMs ?? TIMEOUT_MS) / 1000)} s` }));
      }, opts.timeoutMs ?? TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      signal.addEventListener("abort", abort, { once: true });
      child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.stderr!.setEncoding("utf8").on("data", (d: string) => {
        if (err.length < 64_000) err += d;
      });
      child.on("error", (error) => finish(() => resolve({ error: `pi could not start: ${error.message}` })));
      child.on("close", (code) => {
        finish(() => {
          const r = parsePiJson(out);
          // pi's own answer (a line, or the provider's error) wins; with none, its exit code and stderr say why.
          if (code === 0 || !("error" in r) || r.error !== "pi gave no answer") return resolve(r);
          const words = err
            .split("\n")
            .filter((l) => l.trim() && !/^Warning:/.test(l))
            .join(" ")
            .trim()
            .slice(0, 500);
          resolve({ error: `pi exited ${code}${words ? `: ${words}` : ""}` });
        });
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(req.prompt);
    });
}
