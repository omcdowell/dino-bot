import type { AgentTimelineItem, ToolCallDetail } from "./agent-sdk-types.js";
import { createHash } from "node:crypto";

/**
 * Compact projection (`compactTimeline`). Background and catch-up fetches from clients on slow
 * links ask for tool calls without their large payloads: about 80% of a bot chat's bytes are tool
 * output. A compacted tool call keeps its identity, status, command/path and a short preview, and
 * carries `metadata.paseoCompact` so the client knows to fetch the full item
 * (`agent.timeline.item.request`) when the user expands the row. Live stream rows are never
 * compacted.
 */

export const COMPACT_TOOL_ITEM_MAX_BYTES = 2048;
export const COMPACT_PREVIEW_CHARS = 400;
export const COMPACT_METADATA_KEY = "paseoCompact";

export interface CompactMarker {
  omittedBytes: number;
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

export function readCompactMarker(item: AgentTimelineItem): CompactMarker | null {
  if (item.type !== "tool_call") return null;
  const marker = item.metadata?.[COMPACT_METADATA_KEY];
  if (!marker || typeof marker !== "object") return null;
  const omittedBytes = (marker as { omittedBytes?: unknown }).omittedBytes;
  return typeof omittedBytes === "number" ? { omittedBytes } : null;
}

function head(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= COMPACT_PREVIEW_CHARS) return value;
  return `${value.slice(0, COMPACT_PREVIEW_CHARS)}…`;
}

function tail(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= COMPACT_PREVIEW_CHARS) return value;
  return `…${value.slice(-COMPACT_PREVIEW_CHARS)}`;
}

function previewUnknown(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (json === undefined || json.length <= COMPACT_PREVIEW_CHARS) return value;
  return head(json);
}

function compactDetail(detail: ToolCallDetail): ToolCallDetail {
  switch (detail.type) {
    case "shell":
      return { ...detail, output: tail(detail.output) };
    case "read":
      return { ...detail, content: head(detail.content) };
    case "edit":
      return {
        ...detail,
        oldString: head(detail.oldString),
        newString: head(detail.newString),
        unifiedDiff: head(detail.unifiedDiff),
      };
    case "write":
      return { ...detail, content: head(detail.content) };
    case "search":
      return {
        ...detail,
        content: head(detail.content),
        ...(detail.filePaths ? { filePaths: detail.filePaths.slice(0, 20) } : {}),
        ...(detail.webResults ? { webResults: detail.webResults.slice(0, 10) } : {}),
      };
    case "fetch":
      return { ...detail, result: head(detail.result) };
    case "worktree_setup":
      return {
        ...detail,
        log: tail(detail.log) ?? "",
        commands: detail.commands.map((command) => ({ ...command, log: tail(command.log) ?? "" })),
      };
    case "sub_agent":
      return { ...detail, log: tail(detail.log) ?? "" };
    case "plain_text":
      return { ...detail, text: head(detail.text) };
    case "plan":
      return detail;
    case "unknown":
      return {
        ...detail,
        input: previewUnknown(detail.input),
        output: previewUnknown(detail.output),
      };
    default:
      return detail;
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** Returns the same reference when nothing needs compacting. */
export function compactTimelineItem(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "tool_call") return item;
  if (readCompactMarker(item)) return item;
  const originalBytes = byteLength(item.detail);
  if (originalBytes <= COMPACT_TOOL_ITEM_MAX_BYTES) return item;
  const detail = compactDetail(item.detail);
  const compactedBytes = byteLength(detail);
  if (compactedBytes >= originalBytes) return item;
  const compacted: ToolCallItem = {
    ...item,
    detail,
    metadata: {
      ...item.metadata,
      [COMPACT_METADATA_KEY]: { omittedBytes: originalBytes - compactedBytes },
    },
  };
  return compacted;
}

/**
 * Lean projection (`leanTimeline`), for chats nobody is looking at: background pulls, keep-live
 * catch-up and connect. Reasoning rows are left out and every tool call bigger than a stub
 * becomes one: name, status and the one line that identifies it (command, path, query, url),
 * marked `paseoCompact` like a compact row so expanding it loads the full item. Assistant and
 * user messages are untouched. An open chat never asks for this.
 */
export const LEAN_STUB_MAX_BYTES = 256;
const LEAN_LINE_CHARS = 160;

function line(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = value.split("\n", 1)[0] ?? "";
  return first.length > LEAN_LINE_CHARS || first.length < value.length
    ? `${first.slice(0, LEAN_LINE_CHARS)}…`
    : first;
}

// oxlint-disable-next-line complexity -- one switch case per tool detail type
function leanDetail(detail: ToolCallDetail): ToolCallDetail {
  switch (detail.type) {
    case "shell":
      return {
        type: "shell",
        command: line(detail.command) ?? "",
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
      };
    case "read":
      return { type: "read", filePath: detail.filePath };
    case "edit":
      return { type: "edit", filePath: detail.filePath };
    case "write":
      return { type: "write", filePath: detail.filePath };
    case "search":
      return {
        type: "search",
        query: line(detail.query) ?? "",
        ...(detail.toolName ? { toolName: detail.toolName } : {}),
        ...(detail.numFiles !== undefined ? { numFiles: detail.numFiles } : {}),
        ...(detail.numMatches !== undefined ? { numMatches: detail.numMatches } : {}),
      };
    case "fetch":
      return {
        type: "fetch",
        url: detail.url,
        ...(detail.code !== undefined ? { code: detail.code } : {}),
      };
    case "worktree_setup":
      return { ...detail, log: "", commands: [] };
    case "sub_agent":
      return {
        type: "sub_agent",
        ...(detail.subAgentType ? { subAgentType: detail.subAgentType } : {}),
        ...(detail.description ? { description: line(detail.description) } : {}),
        log: "",
      };
    case "plain_text":
      return {
        type: "plain_text",
        ...(detail.label ? { label: detail.label } : {}),
        ...(detail.icon ? { icon: detail.icon } : {}),
        ...(detail.text ? { text: line(detail.text) } : {}),
      };
    case "plan":
      return { type: "plan", text: line(detail.text) ?? "" };
    case "unknown": {
      const input = typeof detail.input === "string" ? detail.input : JSON.stringify(detail.input);
      return { type: "unknown", input: line(input) ?? null, output: null };
    }
    default:
      return detail;
  }
}

function leanError(error: unknown): unknown {
  if (error === null || error === undefined) return error;
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return line(text) ?? "error";
}

/** Null drops the row (reasoning). Returns the same reference when nothing changes. */
export function leanTimelineItem(item: AgentTimelineItem): AgentTimelineItem | null {
  if (item.type === "reasoning") return null;
  if (item.type !== "tool_call") return item;
  const originalBytes = byteLength(item);
  if (originalBytes <= LEAN_STUB_MAX_BYTES) return item;
  const previous = readCompactMarker(item);
  const { agentMessage: _agentMessage, ...rest } = item as ToolCallItem & {
    agentMessage?: unknown;
  };
  const stub = {
    ...rest,
    detail: leanDetail(item.detail),
    ...(item.status === "failed" ? { error: leanError(item.error) } : {}),
    metadata: {
      ...(item.metadata ? stripLarge(item.metadata) : {}),
      [COMPACT_METADATA_KEY]: { omittedBytes: 0, lean: true },
    },
  } as ToolCallItem;
  const stubBytes = byteLength(stub);
  if (stubBytes >= originalBytes) return item;
  (stub.metadata![COMPACT_METADATA_KEY] as { omittedBytes: number }).omittedBytes =
    (previous?.omittedBytes ?? 0) + originalBytes - stubBytes;
  return stub;
}

/** Keep small metadata values (plugin markers, ids); drop anything large. */
function stripLarge(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === COMPACT_METADATA_KEY) continue;
    if (byteLength(value) <= 128) out[key] = value;
  }
  return out;
}

/**
 * Short projection (PS2 B1b, `priority_sync` clients, pages and live rows). The open chat reads as
 * text with one-line steps: tool calls become the lean stub (name, status, the identifying line,
 * the first error line), reasoning keeps a one-line preview, user and assistant text is never cut.
 * A shortened tool call is marked `metadata.paseoCompact = { omittedBytes, lean, short, bodyHash? }`.
 * `bodyHash` (16 hex, a 64-bit content hash of the full item) is set only once the call is final
 * (completed or failed), so a body cached under it is never stale. The full row comes from
 * `agent.timeline.bodies.request` (by seq or callId) or `agent.timeline.item.request`.
 */
export const SHORT_REASONING_CHARS = 200;

const bodyHashes = new WeakMap<object, string>();

/** 64-bit content hash of the full item, as 16 hex chars. Cached per item object. */
export function timelineBodyHash(item: AgentTimelineItem): string {
  const cached = bodyHashes.get(item);
  if (cached) return cached;
  const hash = createHash("sha256")
    .update(JSON.stringify(item) ?? "")
    .digest("hex")
    .slice(0, 16);
  bodyHashes.set(item, hash);
  return hash;
}

export function isFinalTimelineItem(item: AgentTimelineItem): boolean {
  return item.type !== "tool_call" || item.status === "completed" || item.status === "failed";
}

function previewLine(text: string, chars: number): string {
  const first = text.split("\n", 1)[0] ?? "";
  return first.length > chars || first.length < text.length ? `${first.slice(0, chars)}…` : first;
}

/** Returns the same reference when nothing changes. Never drops a row (live seqs stay dense). */
export function shortTimelineItem(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type === "reasoning") {
    const text = previewLine(item.text, SHORT_REASONING_CHARS);
    return text === item.text ? item : { ...item, text };
  }
  if (item.type !== "tool_call") return item;
  const marker = item.metadata?.[COMPACT_METADATA_KEY] as { short?: unknown } | undefined;
  if (marker?.short === true) return item;
  const stub = leanTimelineItem(item);
  if (!stub || stub === item) return item;
  const leanMarker = (stub as ToolCallItem).metadata?.[COMPACT_METADATA_KEY] as {
    omittedBytes: number;
  };
  return {
    ...stub,
    metadata: {
      ...(stub as ToolCallItem).metadata,
      [COMPACT_METADATA_KEY]: {
        omittedBytes: leanMarker.omittedBytes,
        lean: true,
        short: true,
        ...(isFinalTimelineItem(item) ? { bodyHash: timelineBodyHash(item) } : {}),
      },
    },
  } as AgentTimelineItem;
}
