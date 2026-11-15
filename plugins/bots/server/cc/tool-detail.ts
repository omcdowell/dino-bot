/**
 * A Claude Code tool call (as the view mod reports it: the tool's name, its arguments and its result text) as a
 * typed Paseo tool detail, so the app shows the command, file, pattern or URL instead of a bare "Bash".
 *
 * A small port of Paseo's own Claude provider mapping (paseo/packages/server/src/server/agent/providers/claude/
 * tool-call-detail-parser.ts and tool-call-mapper.ts, plus ../tool-call-detail-primitives.ts), without zod and
 * without server internals, so the plugin builds on its own. Anything it does not know stays `unknown`.
 */
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

type JsonValue = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];
type Rec = Record<string, unknown>;

export interface CcToolCall {
  name: string;
  input?: unknown;
  /** The result text; absent while the tool runs. */
  output?: string;
  /** done: the tool has returned. */
  done: boolean;
  isError?: boolean;
}

const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const opt = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));

const SEARCH_TOOL: Record<string, "grep" | "glob" | "web_search"> = { Grep: "grep", Glob: "glob", WebSearch: "web_search" };
const GREP_MODES = new Set(["content", "files_with_matches", "count"]);

/** The typed detail for a call, or `unknown` with its raw input and output. */
export function ccToolDetail(call: CcToolCall): ProviderToolCallDetail {
  const name = call.name.trim();
  const input = rec(call.input);
  const output = call.done ? str(call.output) : undefined;
  const filePath = str(input.file_path) ?? str(input.filePath) ?? str(input.path);
  switch (name) {
    case "Bash": {
      const command = str(input.command);
      if (!command) break;
      // Claude Code reports a non-zero exit as an error starting "Exit code N"; a plain result is exit 0 (unless the
      // command went to the background, which has no exit code yet: asked to, or moved there on its timeout).
      const exit = call.isError ? /^Exit code (\d+)/.exec(output ?? "")?.[1] : undefined;
      const background = input.run_in_background === true || /^Command\b[^\n]*\b(moved to the background|running in (the )?background)\b/.test(output ?? "");
      const exitCode = !call.done ? undefined : exit !== undefined ? Number(exit) : !call.isError && !background ? 0 : null;
      return { type: "shell", command, ...opt("output", output), ...opt("exitCode", exitCode) };
    }
    case "Read":
      if (!filePath) break;
      return { type: "read", filePath, ...opt("content", call.isError ? undefined : output), ...opt("offset", num(input.offset)), ...opt("limit", num(input.limit)) };
    case "Write":
      if (!filePath) break;
      return { type: "write", filePath, ...opt("content", str(input.content)) };
    case "Edit":
      if (!filePath) break;
      return { type: "edit", filePath, ...opt("oldString", str(input.old_string)), ...opt("newString", str(input.new_string)) };
    case "MultiEdit": {
      if (!filePath) break;
      const edits = Array.isArray(input.edits) ? input.edits.map(rec) : [];
      const join = (k: string) => str(edits.map((e) => (typeof e[k] === "string" ? e[k] : "")).filter(Boolean).join("\n…\n"));
      return { type: "edit", filePath, ...opt("oldString", join("old_string")), ...opt("newString", join("new_string")) };
    }
    case "Grep":
    case "Glob":
    case "WebSearch": {
      const query = str(input.pattern) ?? str(input.query);
      if (!query) break;
      const toolName = SEARCH_TOOL[name]!;
      const mode = typeof input.output_mode === "string" && GREP_MODES.has(input.output_mode) ? (input.output_mode as "content") : undefined;
      const files = toolName === "glob" && output && !call.isError ? output.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")) : [];
      return {
        type: "search",
        query,
        toolName,
        ...opt("content", output),
        ...(files.length ? { filePaths: files, numFiles: files.length } : {}),
        ...opt("mode", toolName === "grep" ? mode : undefined),
      };
    }
    case "WebFetch": {
      const url = str(input.url);
      if (!url) break;
      return { type: "fetch", url, ...opt("prompt", str(input.prompt)), ...opt("result", output) };
    }
    case "Task":
    case "Agent":
      return { type: "sub_agent", ...opt("subAgentType", str(input.subagent_type)), ...opt("description", str(input.description)), log: output ?? "" };
    case "Skill": {
      const skill = str(input.skill);
      if (!skill) break;
      return { type: "plain_text", label: skill, icon: "sparkles", ...opt("text", output) };
    }
    case "ExitPlanMode": {
      const plan = str(input.plan);
      if (!plan) break;
      return { type: "plan", text: plan };
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos.map(rec) : [];
      if (!todos.length) break;
      const mark = (s: unknown) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
      const done = todos.filter((t) => t.status === "completed").length;
      return {
        type: "plain_text",
        label: `${done}/${todos.length} done`,
        icon: "wrench",
        text: todos.map((t) => `${mark(t.status)} ${str(t.content) ?? str(t.activeForm) ?? ""}`).join("\n"),
      };
    }
  }
  return { type: "unknown", input: (call.input ?? null) as JsonValue, output: (call.done ? (call.output ?? null) : null) as JsonValue };
}
