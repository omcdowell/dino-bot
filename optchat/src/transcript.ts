import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, type SystemMessage, type UserMessage } from '@earendil-works/pi-ai';
import { CAP, cap, flat, type Memory } from './memory.ts';
import { record } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

export const RUN_BOUNDARY = 'optchat.run';
/** Subagent reports written by upstream pi-optchat; old sessions may still hold them. */
export const REPORT_TYPE = 'optchat-report';

export function textContent(content: unknown, images = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (typeof part !== 'object' || part === null) return '';
      if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
      if (images && 'type' in part && part.type === 'image')
        return '[image attachment: available in Pi session; text memory does not preserve image bytes]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
/** What the user typed, as Pi's input event (and so the inbox) saw it: no image placeholders, and without the
 * `[Image …]` notes Pi appends after the text when it resizes, converts or omits an attached image. */
export function typedText(content: unknown) {
  const text = textContent(content, false);
  return { text, bare: text.replace(/\n\n\[Image[ :][^\n]*\](?:\n\[Image[ :][^\n]*\])*$/, '') };
}
/** Reports reach the model, memory and the previous-exchange replay exactly as the user messages they used to be. */
export function asUser(message: AgentMessage): AgentMessage {
  if (message.role !== 'custom' || message.customType !== REPORT_TYPE) return message;
  return { role: 'user', content: textContent(message.content), timestamp: message.timestamp };
}
type Failure = { stopReason: string; message: string; date: string };
const failureOf = (message: AgentMessage, date: string): Failure | undefined =>
  message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted')
    ? { stopReason: message.stopReason, message: message.errorMessage ?? 'No further details', date }
    : undefined;
/** A failed reply that said and called nothing. Pi's auto-retry leaves one per attempt. */
const bareFailure = (message: AgentMessage) =>
  message.role === 'assistant' &&
  !!failureOf(message, '') &&
  !message.content.some(block => (block.type === 'text' && block.text.trim()) || block.type === 'toolCall');
const failureLine = (failure: Failure, count = 1) =>
  `Agent ${failure.stopReason}${count > 1 ? ` (${count} times)` : ''}: ${failure.message}`;

export function logMessage(
  memory: Memory,
  message: AgentMessage,
  receipt?: string,
  onFailure: (failure: Failure) => void = failure => void memory.append('echo', failureLine(failure), failure.date),
) {
  const date = new Date(message.timestamp).toISOString();
  if (message.role === 'user') memory.append('user', textContent(message.content), date, receipt);
  else if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) memory.append('talk', block.text, date);
      if (block.type === 'toolCall') memory.append('tool', `${block.name} ${JSON.stringify(block.arguments)}`, date);
    }
    const failure = failureOf(message, date);
    if (failure) onFailure(failure);
  } else if (message.role === 'toolResult') memory.append('echo', cap(`${message.toolName}: ${textContent(message.content)}`), date);
}
const clip = (text: string, limit: number) => {
  const line = flat(text).trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}\u2026 (${line.length} chars)`;
};

/**
 * Writes a run's messages to memory. With `digest`, a run's tool calls, short results and in-between commentary
 * become one `tool` entry, written before the next thing said (a reply, steering, an error) or at `end()`.
 * The full tool output stays in the Pi session; memory keeps what was done and how it went.
 *
 * Consecutive identical errors (Pi's auto-retry attempts) become one `echo` line with a count, dated at the first.
 * The line is written when something else is logged or at `end()`.
 */
export class RunLog {
  private steps: { line: string; id?: string; result?: string }[] = [];
  private date = '';
  private failure: (Failure & { count: number }) | undefined;
  constructor(
    private readonly memory: Memory,
    private readonly digest: boolean,
  ) {}
  write(message: AgentMessage, receipt?: string) {
    if (!bareFailure(message)) this.endFailure();
    if (!this.digest) return logMessage(this.memory, message, receipt, failure => this.fail(failure));
    const date = new Date(message.timestamp).toISOString();
    if (message.role === 'assistant' && message.content.some(block => block.type === 'toolCall')) {
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) this.step(date, { line: `note: ${clip(block.text, 300)}` });
        if (block.type === 'toolCall')
          this.step(date, { line: `- ${block.name} ${clip(JSON.stringify(block.arguments), 300)}`, id: block.id });
      }
      const failure = failureOf(message, date);
      if (failure) {
        this.endSteps();
        this.fail(failure);
      }
      return;
    }
    if (message.role === 'toolResult') {
      // Parallel calls come before their results, so each result goes under the call it answers.
      const result = `  \u2192 ${message.isError ? 'error' : 'ok'}: ${clip(textContent(message.content), 400)}`;
      const call = this.steps.find(step => step.id === message.toolCallId && step.result === undefined);
      if (call) call.result = result;
      else this.step(date, { line: `- ${message.toolName}`, result });
      return;
    }
    this.endSteps();
    logMessage(this.memory, message, receipt, failure => this.fail(failure));
  }
  /** Writes the pending digest and error line, if any. */
  end() {
    this.endSteps();
    this.endFailure();
  }
  private fail(failure: Failure) {
    const pending = this.failure;
    if (pending && pending.stopReason === failure.stopReason && pending.message === failure.message) pending.count++;
    else {
      this.endFailure();
      this.failure = { ...failure, count: 1 };
    }
  }
  private endFailure() {
    const pending = this.failure;
    if (!pending) return;
    this.failure = undefined;
    this.memory.append('echo', failureLine(pending, pending.count), pending.date);
  }
  private endSteps() {
    if (!this.steps.length) return;
    const calls = this.steps.filter(step => step.line.startsWith('- ')).length;
    const lines = this.steps.flatMap(step => (step.result === undefined ? [step.line] : [step.line, step.result]));
    this.steps = [];
    this.memory.append('tool', cap(`Tool steps (${calls} ${calls === 1 ? 'call' : 'calls'}):\n${lines.join('\n')}`), this.date);
  }
  private step(date: string, step: { line: string; id?: string; result?: string }) {
    if (!this.steps.length) this.date = date;
    this.steps.push(step);
  }
}

export function boundedMessage(message: AgentMessage): AgentMessage {
  if (message.role !== 'toolResult') return message;
  const text = message.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
  if (text.length <= CAP) return message;
  return { ...message, content: [{ type: 'text', text: cap(text) }, ...message.content.filter(c => c.type === 'image')] };
}
/** The caller supplies a single settled run, including any steering after text-only replies. */
function completedExchange(history: readonly AgentMessage[]) {
  const last = history.findLastIndex(m => m.role === 'user' || m.role === 'assistant');
  const answer = history[last];
  if (answer?.role !== 'assistant' || answer.stopReason !== 'stop' || answer.content.some(block => block.type === 'toolCall')) return [];
  const content = answer.content.flatMap(block => (block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []));
  if (!content.some(block => block.text.trim())) return [];
  const requests: UserMessage[] = [];
  for (const message of history.slice(0, last)) {
    if (message.role === 'user') requests.push({ ...message, content: textContent(message.content) });
  }
  if (!requests.length) return [];
  return [...requests, { ...answer, content }];
}

/** Default limit in bytes of text (16 KB, ~4,000 tokens). Most exchanges are 1-7 KB; a larger one, usually a big paste, is
 * left out entirely and the model falls back to its summaries in the memory view, zooming for the full text if it needs it. */
export const PREVIOUS_EXCHANGE = DEFAULT_SETTINGS.previousExchangeKB * 1000;

/** The latest successful run on this branch, skipping failed and unfinished runs; none if it is over `limit` bytes. */
export function previousExchange(branch: readonly SessionEntry[], limit = PREVIOUS_EXCHANGE) {
  const exchange = latestExchange(branch);
  const bytes = exchange.reduce((sum, message) => sum + Buffer.byteLength(textContent(message.content)), 0);
  return bytes <= limit ? exchange : [];
}

function latestExchange(branch: readonly SessionEntry[]) {
  let end = -1;
  let legacyEnd = branch.length;
  const messages = (entries: readonly SessionEntry[]) =>
    entries.flatMap(entry =>
      entry.type === 'message'
        ? [asUser(entry.message)]
        : entry.type === 'custom_message' && entry.customType === REPORT_TYPE
          ? [
              asUser({
                role: 'custom',
                customType: entry.customType,
                content: entry.content,
                display: entry.display,
                timestamp: Date.parse(entry.timestamp),
              }),
            ]
          : [],
    );
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== RUN_BOUNDARY || !record(entry.data)) continue;
    legacyEnd = i;
    if (entry.data.state === 'end') end = i;
    else if (entry.data.state === 'start') {
      if (end >= 0) {
        const exchange = completedExchange(messages(branch.slice(i + 1, end)));
        if (exchange.length) return exchange;
      }
      end = -1;
    }
  }
  // Older sessions have no run markers. Recover a successful exchange best-effort;
  // text-only steering boundaries cannot be reconstructed for those old runs.
  const legacy = messages(branch.slice(0, legacyEnd));
  let boundary = 0;
  let latest: ReturnType<typeof completedExchange> = [];
  for (let i = 0; i < legacy.length; i++) {
    const message = legacy[i];
    if (message.role !== 'assistant' || message.stopReason === 'toolUse') continue;
    const exchange = completedExchange(legacy.slice(boundary, i + 1));
    if (exchange.length) latest = exchange;
    boundary = i + 1;
  }
  return latest;
}

/** Keep one completed exchange plus the current run; all other history comes from the view. */
export function buildContext(
  canonical: AgentMessage[],
  run: AgentMessage[],
  view: string,
  prompt: string,
  previous: readonly AgentMessage[] = [],
): AgentMessage[] {
  const system = getCurrentSystemMessage(canonical);
  const head: SystemMessage = { role: 'system', content: prompt, toolsAdded: system?.toolsAdded, timestamp: 0 };
  if (!run.some(m => m.role === 'user')) throw new Error('OptChat has no current user message; refusing to send historical context.');
  let injected = false;
  const messages = [...previous, ...run]
    .filter(m => m.role !== 'system')
    .map(message => {
      if (message.role !== 'user' || injected) return message;
      injected = true;
      return {
        ...message,
        content: [
          { type: 'text' as const, text: view },
          ...(typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content),
        ],
      };
    });
  return [head, ...messages];
}
