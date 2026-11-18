import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cap, flat, type Memory } from './memory.ts';

/**
 * The parts of a pi agent message (pi-agent-core's AgentMessage) a run log reads. Structural on purpose: a type import
 * of pi-agent-core pulls pi's whole type graph (pi-ai, the Anthropic SDK) into any host that imports this file, and
 * Paseo's plugin compiler walks type imports too, so the bots plugin would not load.
 */
type Block = { type: string; text?: string; id?: string; name?: string; arguments?: unknown };
export type LogMessage = {
  role: string;
  timestamp: number;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};
type AgentMessage = LogMessage;
const blocks = (message: LogMessage): Block[] => (Array.isArray(message.content) ? (message.content as Block[]) : []);

/**
 * How a run's messages are written to memory (RunLog), apart from transcript.ts so a host without pi's packages (the
 * DinoBot bots plugin's Claude Code bots) logs a turn the same way.
 */

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

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** The notes Pi appends after the typed text when it resizes, converts or omits an attached image (transcript.ts). */
export const PI_IMAGE_NOTES = /\n\n\[Image[ :][^\n]*\](?:\n\[Image[ :][^\n]*\])*$/;
/** How a kept image is named in memory; the DinoBot bots plugin reads it back (server/cc/provider.ts promptImages). */
export const imageLine = (path: string) => `[image: ${path} (read the file to see it)]`;

/** Writes an image to `dir`/<sha256>.<ext> (kept by content, so a resent image is one file) and returns its path. */
export function keepImage(dir: string, data: string, mimeType: string): string {
  const bytes = Buffer.from(data, 'base64');
  const path = join(dir, `${createHash('sha256').update(bytes).digest('hex')}.${IMAGE_EXT[mimeType] ?? 'bin'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

/**
 * A user message's text for memory. With `imagesDir`, each attached image is kept there and named by an image line,
 * as a Claude Code bot logs one, so the chat shows it again whichever engine the bot runs on later; Pi's notes about
 * the resize go, as they describe the copy in the Pi session. Without it (or if an image cannot be written), an image
 * is the text placeholder.
 */
export function userText(content: unknown, imagesDir?: string): string {
  if (!imagesDir || !Array.isArray(content)) return textContent(content);
  const parts = content as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }[];
  const images = parts.filter(p => typeof p === 'object' && p !== null && p.type === 'image');
  if (!images.length || !images.every(p => typeof p.data === 'string' && typeof p.mimeType === 'string')) return textContent(content);
  let lines: string[];
  try {
    lines = images.map(p => imageLine(keepImage(imagesDir, p.data as string, p.mimeType as string)));
  } catch {
    return textContent(content);
  }
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'object' || p === null) continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text.replace(PI_IMAGE_NOTES, ''));
    else if (p.type === 'image') out.push(lines.shift()!);
  }
  return out.filter(Boolean).join('\n').trim();
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
  !blocks(message).some(block => (block.type === 'text' && block.text?.trim()) || block.type === 'toolCall');
const failureLine = (failure: Failure, count = 1) =>
  `Agent ${failure.stopReason}${count > 1 ? ` (${count} times)` : ''}: ${failure.message}`;

export function logMessage(
  memory: Memory,
  message: AgentMessage,
  receipt?: string,
  onFailure: (failure: Failure) => void = failure => void memory.append('echo', failureLine(failure), failure.date),
  imagesDir?: string,
) {
  const date = new Date(message.timestamp).toISOString();
  if (message.role === 'user') memory.append('user', userText(message.content, imagesDir), date, receipt);
  else if (message.role === 'assistant') {
    for (const block of blocks(message)) {
      if (block.type === 'text' && block.text?.trim()) memory.append('talk', block.text, date);
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
    /** Where the images a user message carries are kept (the profile's images/); unset, memory keeps a placeholder. */
    private readonly imagesDir?: string,
  ) {}
  write(message: AgentMessage, receipt?: string) {
    if (!bareFailure(message)) this.endFailure();
    if (!this.digest) return logMessage(this.memory, message, receipt, failure => this.fail(failure), this.imagesDir);
    const date = new Date(message.timestamp).toISOString();
    if (message.role === 'assistant' && blocks(message).some(block => block.type === 'toolCall')) {
      for (const block of blocks(message)) {
        if (block.type === 'text' && block.text?.trim()) this.step(date, { line: `note: ${clip(block.text, 300)}` });
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
    logMessage(this.memory, message, receipt, failure => this.fail(failure), this.imagesDir);
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
