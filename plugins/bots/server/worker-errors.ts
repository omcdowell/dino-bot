/**
 * Did a herdr worker stop on an error? (2026-10-10: warn when a worker stops on an error
 * without reporting, instead of counting it as finished.)
 *
 * Signal, in order:
 *   1. The agent's session file: the path herdr reports for the pane (`agent_session.value`, kind
 *      "path"; pi), else the one recorded at launch (`session` in the launch registry: herdr gives
 *      Claude Code agents no session, so launch.sh records the transcript Claude Code writes). Both
 *      engines append every message to it; a turn that ends on an API failure (after the engine's own
 *      retries) leaves that failure as the last message entry:
 *        - pi: an assistant message with `stopReason` "error" or "aborted" and an `errorMessage`
 *          ("Request timed out.", "429 {…}", "Connection error.", "Operation aborted", …);
 *        - Claude Code: an assistant entry with `isApiErrorMessage: true` (model "<synthetic>"), its
 *          text the error ("API Error: …", "Login expired · Please run /login") and `apiErrorStatus`
 *          the HTTP status (429, 529, …); or a user entry "[Request interrupted by user…]" (Esc, as
 *          pi's "aborted").
 *      Structured, tied to the exact worker, and exact about time.
 *      Claude Code only: herdr shows a claude agent `idle` while Claude Code waits out its own API
 *      retries ("429 … · Retrying in 27s · attempt 8/10"; measured 2026-11-18, 2.1.323), and the
 *      transcript then ends on the user prompt. Claude Code's own record of the running session,
 *      `<config dir>/sessions/<pid>.json` (`sessionId`, `status` "busy" | "idle"), says busy, so the
 *      reader answers "working" and the worker stays running, as a retrying pi worker does.
 *   2. Only when there is no session file (another agent kind, or no path known for the pane): the
 *      last lines of the pane's terminal output, matched against known error lines.
 *      Heuristic, so it only looks at the bottom of the screen and only at error-shaped lines.
 *
 * Imports carry `.ts` extensions so bin/bot-worker.mjs can run this file with Node type stripping.
 */
import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tailLines } from "./tail.ts";
import type { HerdrAgent } from "./workers.ts";

export type StallError = {
  /** The error as the engine recorded it (or the matched pane line), at most MAX_ERROR_CHARS. */
  message: string;
  /** When the failing message was written (session), or null (pane: no time). */
  at: string | null;
  source: "session" | "pane";
};

/**
 * What a session file says about an idle worker: the error it stopped on, "working" (Claude Code is
 * still on its turn, e.g. retrying, although herdr shows it idle), or null (no error stop known).
 * `session`: the session file recorded at launch (the launch registry), used when herdr reports none.
 */
export type ErrorReader = (agent: HerdrAgent, session?: string | null) => Promise<StallError | "working" | null>;

const SESSION_TAIL_BYTES = 512 * 1024;
export const MAX_ERROR_CHARS = 300;
/** Pane fallback: only this many non-empty lines from the bottom are looked at. */
export const PANE_LINES = 25;

const clip = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_ERROR_CHARS ? `${one.slice(0, MAX_ERROR_CHARS - 1)}…` : one;
};

const timeOf = (entry: any) => (typeof entry?.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp)) ? entry.timestamp : null);

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join(" ")
      : "";

/**
 * One session entry: undefined when it is not a message (skip it), null when it is a message that is
 * not an error stop, else the error. pi entries are `type: "message"`; Claude Code ones `type:
 * "user" | "assistant"` (its other entries: system turn_duration/api_error retries, attachments,
 * last-prompt, cost-state, … are skipped; so are subagent (`isSidechain`) messages).
 */
function entryStop(entry: any): StallError | null | undefined {
  if (entry?.type === "message" && entry.message) {
    const message = entry.message;
    if (message.role !== "assistant") return null;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") return null;
    const text = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : message.stopReason;
    return { message: clip(text), at: timeOf(entry), source: "session" };
  }
  if ((entry?.type !== "assistant" && entry?.type !== "user") || !entry.message || entry.isSidechain === true) return undefined;
  const text = textOf(entry.message.content).trim();
  if (entry.type === "user") {
    return /^\[Request interrupted by user/.test(text) ? { message: "Request interrupted by user", at: timeOf(entry), source: "session" } : null;
  }
  if (entry.isApiErrorMessage !== true) return null;
  const status = typeof entry.apiErrorStatus === "number" ? String(entry.apiErrorStatus) : "";
  const message = text || (typeof entry.error === "string" ? entry.error : "API error");
  return { message: clip(status && !message.includes(status) ? `${status} ${message}` : message), at: timeOf(entry), source: "session" };
}

/**
 * The error a pi session or Claude Code transcript ended on, from its jsonl lines (oldest first).
 * Looks at the last message entry only: an API failure (or an interrupt) is a stop on an error;
 * anything else (a later successful reply, a tool result, a new user prompt) is not. No message
 * entry in the lines: null (unknown).
 */
export function sessionStopError(lines: readonly string[]): StallError | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const stop = entryStop(entry);
    if (stop !== undefined) return stop;
  }
  return null;
}

/** Error lines pi and Claude Code (and similar TUIs) print when a turn dies on the API. */
export const PANE_ERROR_RE =
  /^(?:[^\w]{0,4})(?:Error: .+|.*Retry failed after \d+ attempts.*|.*Request timed out.*|.*\b(?:429|401|403|500|502|503|529)\b.*(?:error|rate.?limit|overloaded|unauthori[sz]ed|forbidden|too many requests).*|.*\boverloaded_error\b.*|.*Operation aborted.*|.*Request (?:was )?aborted.*)$/i;

/** Claude Code's status line while it waits out its own retries ("429 … · Retrying in 11s · attempt 6/10"): busy, not stopped. */
export const PANE_RETRY_RE = /\bRetrying in \d+\s*(?:s|ms|m)\b/i;

/**
 * The error at the bottom of a pane's output, if the last PANE_LINES non-empty lines hold one. A
 * retry line below (or on) it means the engine is still at it: no error.
 */
export function paneStopError(text: string): StallError | null {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const bottom = lines.slice(-PANE_LINES);
  for (let i = bottom.length - 1; i >= 0; i--) {
    const line = bottom[i]!.trim();
    if (PANE_RETRY_RE.test(line)) return null;
    if (PANE_ERROR_RE.test(line)) return { message: clip(line), at: null, source: "pane" };
  }
  return null;
}

export async function readSessionError(path: string): Promise<StallError | "working" | null> {
  if (await ccSessionBusy(path)) return "working";
  return sessionStopError(await tailLines(path, SESSION_TAIL_BYTES));
}

/**
 * Is the Claude Code session of this transcript (`<config>/projects/<cwd slug>/<session id>.jsonl`)
 * on a turn? Claude Code keeps `<config>/sessions/<pid>.json` for each running TUI, with its
 * `sessionId` and `status` ("busy" while on a turn, retries included; "idle" after it). False for
 * anything else (a pi session, no record, a dead pid).
 */
export async function ccSessionBusy(transcript: string): Promise<boolean> {
  if (!transcript.endsWith(".jsonl") || basename(dirname(dirname(transcript))) !== "projects") return false;
  const sessionId = basename(transcript, ".jsonl");
  const dir = join(dirname(dirname(dirname(transcript))), "sessions");
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let record: any;
    try {
      record = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (record?.sessionId !== sessionId) continue;
    return record.status === "busy" && alive(record.pid);
  }
  return false;
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Session file of a pane's agent: the path herdr reports (pi), else `recorded`, the one recorded at
 * launch (Claude Code: herdr reports none). Absolute paths only.
 */
export function sessionPath(agent: HerdrAgent, recorded?: string | null): string | null {
  const session = agent.agent_session;
  const fromHerdr =
    session && typeof session.value === "string" && (!session.kind || session.kind === "path") && session.value.startsWith("/")
      ? session.value
      : null;
  return fromHerdr ?? (typeof recorded === "string" && recorded.startsWith("/") ? recorded : null);
}

/** Session file only (no herdr call): what tests and injected-herdr callers get by default. */
export const sessionErrorReader: ErrorReader = async (agent, recorded) => {
  const path = sessionPath(agent, recorded);
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
  return async (agent, recorded) => {
    const path = sessionPath(agent, recorded);
    // A recorded path Claude Code never wrote (another config dir, say) leaves the pane to go on.
    if (path && (await access(path).then(() => true, () => false))) {
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
