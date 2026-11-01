/**
 * Did a herdr worker stop on an error? (2026-10-10: warn when a worker stops on an error
 * without reporting, instead of counting it as finished.)
 *
 * Signal, in order:
 *   1. The pi session file herdr reports for the pane (`agent_session.value`, kind "path"). pi
 *      appends every assistant message to it; a turn that ends on an API failure (after pi's own
 *      retries) leaves an assistant message with `stopReason` "error" or "aborted" and an
 *      `errorMessage` ("Request timed out.", "429 {…}", "Connection error.", "Operation aborted", …)
 *      as the last message entry. Structured, tied to the exact pane, and exact about time.
 *   2. Only when there is no session file (another agent kind, or herdr has no session for the
 *      pane): the last lines of the pane's terminal output, matched against known error lines.
 *      Heuristic, so it only looks at the bottom of the screen and only at error-shaped lines.
 *
 * Imports carry `.ts` extensions so bin/bot-worker.mjs can run this file with Node type stripping.
 */
import { execFile } from "node:child_process";
import { tailLines } from "./tail.ts";
import type { HerdrAgent } from "./workers.ts";

export type StallError = {
  /** The error as pi recorded it (or the matched pane line), at most MAX_ERROR_CHARS. */
  message: string;
  /** When the failing message was written (session), or null (pane: no time). */
  at: string | null;
  source: "session" | "pane";
};

export type ErrorReader = (agent: HerdrAgent) => Promise<StallError | null>;

const SESSION_TAIL_BYTES = 512 * 1024;
export const MAX_ERROR_CHARS = 300;
/** Pane fallback: only this many non-empty lines from the bottom are looked at. */
export const PANE_LINES = 25;

const clip = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_ERROR_CHARS ? `${one.slice(0, MAX_ERROR_CHARS - 1)}…` : one;
};

/**
 * The error a pi session ended on, from its jsonl lines (oldest first). Looks at the last `message`
 * entry only: an assistant message with stopReason error/aborted is a stop on an error; anything
 * else (a later successful reply, a tool result, a new user prompt) is not. No message entry in
 * the lines: null (unknown).
 */
export function sessionStopError(lines: readonly string[]): StallError | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role !== "assistant") return null;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") return null;
    const text = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : message.stopReason;
    const at = typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp)) ? entry.timestamp : null;
    return { message: clip(text), at, source: "session" };
  }
  return null;
}

/** Error lines pi (and similar TUIs) print when a turn dies on the API. */
export const PANE_ERROR_RE =
  /^(?:[^\w]{0,4})(?:Error: .+|.*Retry failed after \d+ attempts.*|.*Request timed out.*|.*\b(?:429|401|403|500|502|503|529)\b.*(?:error|rate.?limit|overloaded|unauthori[sz]ed|forbidden|too many requests).*|.*\boverloaded_error\b.*|.*Operation aborted.*|.*Request (?:was )?aborted.*)$/i;

/** The error at the bottom of a pane's output, if the last PANE_LINES non-empty lines hold one. */
export function paneStopError(text: string): StallError | null {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const bottom = lines.slice(-PANE_LINES);
  for (let i = bottom.length - 1; i >= 0; i--) {
    const line = bottom[i]!.trim();
    if (PANE_ERROR_RE.test(line)) return { message: clip(line), at: null, source: "pane" };
  }
  return null;
}

export async function readSessionError(path: string): Promise<StallError | null> {
  return sessionStopError(await tailLines(path, SESSION_TAIL_BYTES));
}

/** Session path herdr reports for a pane's agent, when it is a file path. */
export function sessionPath(agent: HerdrAgent): string | null {
  const session = agent.agent_session;
  if (!session || typeof session.value !== "string" || !session.value) return null;
  if (session.kind && session.kind !== "path") return null;
  return session.value.startsWith("/") ? session.value : null;
}

/** Session file only (no herdr call): what tests and injected-herdr callers get by default. */
export const sessionErrorReader: ErrorReader = async (agent) => {
  const path = sessionPath(agent);
  return path ? readSessionError(path).catch(() => null) : null;
};

/** Real reader: session file first; pane output (`herdr agent read`) only without one. */
export function herdrErrorReader(env: NodeJS.ProcessEnv = process.env): ErrorReader {
  const bin = env.PASEO_BOTS_HERDR || "herdr";
  const readPane = (pane: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        ["agent", "read", pane, "--source", "recent", "--lines", String(PANE_LINES * 2)],
        { env, timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  return async (agent) => {
    const path = sessionPath(agent);
    if (path) {
      try {
        return await readSessionError(path);
      } catch {
        // unreadable session file: fall through to the pane
      }
    }
    try {
      return paneStopError(await readPane(agent.pane_id));
    } catch {
      return null;
    }
  };
}
