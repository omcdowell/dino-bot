/**
 * Claude Code's `<task-notification>`: when a background task ends (a Bash command that ran past its timeout or was
 * started with run_in_background, a background agent), Claude Code submits a prompt like
 *
 *   <task-notification><task-id>b1</task-id><tool-use-id>toolu_…</tool-use-id><output-file>…</output-file>
 *   <status>completed</status><summary>Background command "…" completed (exit code 0)</summary></task-notification>
 *
 * as a turn of its own (origin kind `task-notification`; the model sees it marked "NOT USER INPUT"). It is not the
 * person's words: the app shows it as a row for the finished task, linked to the call that started it, as Paseo's own
 * Claude provider does (paseo/packages/server/src/server/agent/providers/claude/task-notification-tool-call.ts).
 * The view mod (../../claude-code/view) has the same parser in JS for the bot's memory.
 */
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

export interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
  outputFile: string | null;
}

const MARKER = /^\s*<task-notification>/;

const tag = (text: string, ...names: string[]) => {
  for (const name of names) {
    const v = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i").exec(text)?.[1]?.trim();
    if (v) return v;
  }
  return null;
};

/** The notification in a prompt's text, or null when the text is not one. */
export function parseTaskNotification(text: string): TaskNotification | null {
  if (!MARKER.test(text)) return null;
  return {
    taskId: tag(text, "task-id", "task_id"),
    toolUseId: tag(text, "tool-use-id", "tool_use_id"),
    status: tag(text, "status"),
    summary: tag(text, "summary"),
    outputFile: tag(text, "output-file", "output_file"),
  };
}

type ToolCallItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

/** The app's row for a finished background task: label = Claude Code's summary, status from its status. */
export function taskNotificationItem(n: TaskNotification, fallbackId: string): ToolCallItem {
  const status = n.status?.toLowerCase() ?? "";
  const label = n.summary ?? (status ? `Background task ${status}` : "Background task notification");
  const id = n.taskId ?? fallbackId;
  const text = [n.outputFile && `Output: ${n.outputFile}`, n.toolUseId && `Started by call ${n.toolUseId}`].filter(Boolean).join("\n");
  const base = {
    type: "tool_call" as const,
    id: `c-task-${id}`,
    callId: `task-${id}`,
    name: "task_notification",
    detail: { type: "plain_text" as const, label, icon: /^Background command/i.test(label) ? ("square_terminal" as const) : ("wrench" as const), ...(text ? { text } : {}) },
    metadata: {
      synthetic: true,
      source: "claude_task_notification",
      ...(n.taskId ? { taskId: n.taskId } : {}),
      ...(n.toolUseId ? { toolUseId: n.toolUseId } : {}),
      ...(n.status ? { status: n.status } : {}),
      ...(n.outputFile ? { outputFile: n.outputFile } : {}),
    },
  };
  if (status === "failed" || status === "error") return { ...base, status: "failed", error: { message: label } };
  if (["killed", "stopped", "canceled", "cancelled"].includes(status)) return { ...base, status: "canceled", error: null };
  return { ...base, status: "completed", error: null };
}
