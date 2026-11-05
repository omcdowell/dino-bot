import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const QueuedMessageSchema = z.object({
  messageId: z.string(),
  text: z.string(),
  images: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
  attachments: z.unknown().optional(),
  sourceAgentId: z.string().optional(),
  createdAt: z.string(),
});

const QueueFileSchema = z.object({
  agentId: z.string(),
  revision: z.number().int(),
  items: z.array(QueuedMessageSchema),
});

export type QueuedAgentMessage = z.infer<typeof QueuedMessageSchema>;

export interface AgentQueueSnapshot {
  revision: number;
  items: Array<{ messageId: string; text: string; createdAt: string }>;
}

/** Wire previews stay small: the sender keeps the full text in its own outbox. */
const PREVIEW_TEXT_LIMIT = 500;

interface AgentMessageQueueOptions {
  directory: string;
  logger: Logger;
  /** Hands a message to the agent; resolves once the agent took it (turn started or steered). */
  dispatch: (
    agentId: string,
    message: QueuedAgentMessage,
    behavior: "steer" | "interrupt",
  ) => Promise<void>;
  /** True while the agent must not be handed the next message (see isAgentBusyForQueue). */
  isBusy: (agentId: string) => boolean;
  /** The agent took a held message: its receipt can complete. */
  onDelivered: (agentId: string, messageId: string) => Promise<void>;
  /** The queue for an agent changed (publish it on the agent snapshot). */
  onChange: (agentId: string, snapshot: AgentQueueSnapshot) => void;
}

/**
 * Whether a held message must keep waiting: the agent is starting, running a turn or being
 * replaced. An agent whose last turn failed (lifecycle "error", no turn running) is NOT busy:
 * the next message starts a new turn, as a direct send would. Counting "error" as busy left
 * every later message queued forever after one provider error (DinoBot sim walk, 27 Oct).
 */
export function isAgentBusyForQueue(agent: {
  lifecycle: string;
  pendingReplacement?: boolean;
  activeForegroundTurnId: string | null;
}): boolean {
  return (
    agent.lifecycle === "running" ||
    agent.lifecycle === "initializing" ||
    agent.pendingReplacement === true ||
    agent.activeForegroundTurnId !== null
  );
}

/**
 * Per-agent FIFO of messages the daemon holds until the agent is idle (the grey double tick).
 * Saved to disk so a daemon restart keeps them. One message is handed over per idle edge, so
 * every device sees each message turn into the agent's canonical user message, in order.
 */
export class AgentMessageQueue {
  private readonly queues = new Map<string, { revision: number; items: QueuedAgentMessage[] }>();
  private readonly draining = new Set<string>();
  /** Message being handed over right now, per agent. */
  private readonly inFlight = new Map<string, string>();
  /** Agents whose last hand-over failed; the queue waits for the agent to run again. */
  private readonly held = new Set<string>();
  private writes = Promise.resolve();

  constructor(private readonly options: AgentMessageQueueOptions) {}

  async load(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.options.directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const agentIds: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const file = QueueFileSchema.parse(
          JSON.parse(await readFile(path.join(this.options.directory, name), "utf8")),
        );
        if (file.items.length === 0) continue;
        this.queues.set(file.agentId, {
          revision: file.revision,
          items: file.items,
        });
        agentIds.push(file.agentId);
      } catch (error) {
        this.options.logger.warn({ err: error, file: name }, "agent_queue.load_failed");
      }
    }
    return agentIds;
  }

  snapshot(agentId: string): AgentQueueSnapshot | null {
    const queue = this.queues.get(agentId);
    if (!queue || queue.items.length === 0) return null;
    return toSnapshot(queue);
  }

  /** A new queued message would wait: others are ahead of it, or the agent is busy. */
  wouldHold(agentId: string): boolean {
    return !this.isEmpty(agentId) || this.options.isBusy(agentId);
  }

  isEmpty(agentId: string): boolean {
    return (this.queues.get(agentId)?.items.length ?? 0) === 0;
  }

  has(agentId: string, messageId: string): boolean {
    return this.queues.get(agentId)?.items.some((item) => item.messageId === messageId) ?? false;
  }

  /** Queued, or being handed to the agent right now. */
  holds(agentId: string, messageId: string): boolean {
    return this.has(agentId, messageId) || this.inFlight.get(agentId) === messageId;
  }

  async enqueue(agentId: string, message: QueuedAgentMessage): Promise<void> {
    if (this.has(agentId, message.messageId)) return;
    const queue = this.queues.get(agentId) ?? { revision: 0, items: [] };
    queue.items.push(message);
    queue.revision += 1;
    this.queues.set(agentId, queue);
    await this.commit(agentId);
    this.kick(agentId);
  }

  /** Removes a message the agent has not been handed yet. False when it is no longer held. */
  async withdraw(agentId: string, messageId: string): Promise<boolean> {
    const queue = this.queues.get(agentId);
    const index = queue?.items.findIndex((item) => item.messageId === messageId) ?? -1;
    if (!queue || index < 0) return false;
    queue.items.splice(index, 1);
    queue.revision += 1;
    await this.commit(agentId);
    return true;
  }

  /** Sends a held message now, steered into the running turn. */
  async force(agentId: string, messageId: string): Promise<"forced" | "not_queued"> {
    const queue = this.queues.get(agentId);
    const message = queue?.items.find((item) => item.messageId === messageId);
    if (!message || !(await this.withdraw(agentId, messageId))) return "not_queued";
    this.held.delete(agentId);
    this.inFlight.set(agentId, messageId);
    try {
      await this.options.dispatch(agentId, message, "steer");
    } catch (error) {
      await this.putBack(agentId, message);
      throw error;
    } finally {
      if (this.inFlight.get(agentId) === messageId) this.inFlight.delete(agentId);
    }
    await this.options.onDelivered(agentId, messageId);
    return "forced";
  }

  /** The agent is running again: a failed hand-over may be retried at its next idle edge. */
  release(agentId: string): void {
    this.held.delete(agentId);
  }

  /** Hands the next message to the agent if it is idle. Safe to call on every state change. */
  kick(agentId: string): void {
    const queue = this.queues.get(agentId);
    if (!queue || queue.items.length === 0) return;
    if (this.draining.has(agentId) || this.held.has(agentId)) return;
    if (this.options.isBusy(agentId)) return;
    const message = queue.items[0];
    this.draining.add(agentId);
    void this.drainOne(agentId, message).finally(() => {
      this.draining.delete(agentId);
    });
  }

  async drop(agentId: string): Promise<void> {
    if (!this.queues.delete(agentId)) return;
    this.held.delete(agentId);
    await this.enqueueWrite(() =>
      rm(path.join(this.options.directory, fileName(agentId)), { force: true }),
    );
    this.options.onChange(agentId, { revision: 0, items: [] });
  }

  private async drainOne(agentId: string, message: QueuedAgentMessage): Promise<void> {
    if (!(await this.withdraw(agentId, message.messageId))) return;
    this.inFlight.set(agentId, message.messageId);
    try {
      await this.options.dispatch(agentId, message, "steer");
    } catch (error) {
      this.options.logger.warn(
        { err: error, agentId, messageId: message.messageId },
        "agent_queue.dispatch_failed",
      );
      this.held.add(agentId);
      await this.putBack(agentId, message);
      return;
    } finally {
      if (this.inFlight.get(agentId) === message.messageId) this.inFlight.delete(agentId);
    }
    try {
      await this.options.onDelivered(agentId, message.messageId);
    } catch (error) {
      this.options.logger.warn({ err: error, agentId }, "agent_queue.receipt_failed");
    }
  }

  private async putBack(agentId: string, message: QueuedAgentMessage): Promise<void> {
    const queue = this.queues.get(agentId) ?? { revision: 0, items: [] };
    if (queue.items.some((item) => item.messageId === message.messageId)) return;
    queue.items.unshift(message);
    queue.revision += 1;
    this.queues.set(agentId, queue);
    await this.commit(agentId);
  }

  private async commit(agentId: string): Promise<void> {
    const queue = this.queues.get(agentId);
    if (!queue) return;
    const file = path.join(this.options.directory, fileName(agentId));
    const content = {
      agentId,
      revision: queue.revision,
      items: [...queue.items],
    };
    await this.enqueueWrite(() =>
      content.items.length === 0 ? rm(file, { force: true }) : writeJsonFileAtomic(file, content),
    );
    this.options.onChange(agentId, toSnapshot(queue));
  }

  private enqueueWrite(write: () => Promise<unknown>): Promise<void> {
    const next = this.writes.then(write).then(() => undefined);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

function toSnapshot(queue: { revision: number; items: QueuedAgentMessage[] }): AgentQueueSnapshot {
  return {
    revision: queue.revision,
    items: queue.items.map((item) => ({
      messageId: item.messageId,
      text:
        item.text.length > PREVIEW_TEXT_LIMIT ? item.text.slice(0, PREVIEW_TEXT_LIMIT) : item.text,
      createdAt: item.createdAt,
    })),
  };
}

function fileName(agentId: string): string {
  return `${encodeURIComponent(agentId)}.json`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
