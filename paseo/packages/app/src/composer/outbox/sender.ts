import type { ActiveTurnBehavior, AgentAttachment } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata } from "@/attachments/types";
import { generateMessageId } from "@/types/stream";
import {
  addOutboxRecord,
  getOutboxRecord,
  onOutboxChanged,
  removeOutboxRecord,
  requestOutboxEdit,
  updateOutboxRecord,
  useOutboxStore,
  type OutboxRecord,
} from "@/stores/outbox-store";

/**
 * Delivers the saved outbox (stores/outbox-store.ts) to the daemon.
 *
 * - Per agent, in order: message n+1 goes only once message n has at least a single tick, so
 *   the agent gets them in the order they were typed.
 * - Retries transport failures for ever (1 s doubling to 30 s, ±20 %), whatever the age; the
 *   same message ID and an identical payload every time, so the daemon's receipts dedupe.
 * - Nothing goes while the host is offline; an online edge resets the backoff.
 * - A pending delete (cancel) goes before any retry, and a message being deleted is never resent.
 */

export interface OutboxSendClient {
  sendAgentMessage: (
    agentId: string,
    text: string,
    options: {
      messageId: string;
      activeTurnBehavior?: ActiveTurnBehavior;
      images: Array<{ data: string; mimeType: string }>;
      attachments: AgentAttachment[];
      onReceived?: () => void;
    },
  ) => Promise<{ disposition?: string } | void>;
  cancelAgentMessage?: (
    agentId: string,
    messageId: string,
  ) => Promise<{ result: "cancelled" | "too_late" | "failed"; error: string | null }>;
  forceQueuedAgentMessage?: (
    agentId: string,
    messageId: string,
  ) => Promise<{ result: "forced" | "not_queued" | "failed"; error: string | null }>;
}

export interface OutboxHostFeatures {
  messageReceivedAck: boolean;
  agentMessageQueue: boolean;
}

export interface OutboxSenderHost {
  getClient: (serverId: string) => OutboxSendClient | null;
  isOnline: (serverId: string) => boolean;
  features: (serverId: string) => OutboxHostFeatures;
  /** True while the daemon's queue snapshot for the agent lists this message. */
  daemonHolds: (serverId: string, agentId: string, messageId: string) => boolean;
  encodeImages: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER = 0.2;
/** A record the daemon should hold or have finished is re-sent (deduped) to learn its fate. */
const SETTLE_RETRY_MS = 5000;

export type OutboxSendErrorKind = "transport" | "unknown" | "cancelled" | "rejected";

export function classifyOutboxSendError(error: unknown): OutboxSendErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("agent_request_outcome_unknown")) return "unknown";
  if (message === "cancelled") return "cancelled";
  if (error instanceof Error && error.name === "DaemonConnectionError") return "transport";
  if (
    /transport|connection|disconnect|timed out|timeout|socket|closed|offline|network|not connected/i.test(
      message,
    )
  ) {
    return "transport";
  }
  return "rejected";
}

export function outboxBackoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  return Math.round(base * (1 + (random() * 2 - 1) * BACKOFF_JITTER));
}

const OPEN_STATES = new Set<OutboxRecord["state"]>(["outbox", "received", "queued"]);

export class OutboxSender {
  private readonly inFlight = new Set<string>();
  /** Cancels go even while the send is in flight: the daemon tombstones an unseen ID. */
  private readonly cancelsInFlight = new Set<string>();
  private timer: unknown = null;
  private timerAt = Infinity;
  private scheduled = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly host: OutboxSenderHost) {
    this.now = host.now ?? Date.now;
    this.random = host.random ?? Math.random;
    this.setTimer = host.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer =
      host.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.unsubscribe = onOutboxChanged(() => this.kick());
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  isInFlight(clientMessageId: string): boolean {
    return this.inFlight.has(clientMessageId);
  }

  /** Look at the outbox again soon (coalesced). */
  kick(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.run();
    });
  }

  /** The host came online: retry everything now. */
  hostOnline(serverId: string): void {
    this.retryNow(serverId);
  }

  /** Drop the backoff and retry now, for one host or (network regained) all of them. */
  retryNow(serverId?: string): void {
    for (const record of useOutboxStore.getState().records) {
      if ((serverId === undefined || record.serverId === serverId) && record.nextAttemptAt > 0) {
        void updateOutboxRecord(record.clientMessageId, { nextAttemptAt: 0 });
      }
    }
    this.kick();
  }

  run(): void {
    if (this.disposed) return;
    const records = useOutboxStore.getState().records;
    const byAgent = new Map<string, OutboxRecord[]>();
    for (const record of records) {
      const key = `${record.serverId}\u0000${record.agentId}`;
      const list = byAgent.get(key);
      if (list) list.push(record);
      else byAgent.set(key, [record]);
    }
    let wakeAt = Infinity;
    for (const list of byAgent.values()) {
      const serverId = list[0].serverId;
      if (!this.host.isOnline(serverId)) continue;
      const client = this.host.getClient(serverId);
      if (!client) continue;
      wakeAt = Math.min(wakeAt, this.runAgent(client, list));
    }
    this.armTimer(wakeAt);
  }

  private runAgent(client: OutboxSendClient, list: OutboxRecord[]): number {
    const now = this.now();
    let wakeAt = Infinity;
    // Deletes first: they must reach the daemon before any retry of the same message.
    for (const record of list) {
      if (record.state !== "cancelling" || this.cancelsInFlight.has(record.clientMessageId)) {
        continue;
      }
      if (record.nextAttemptAt > now) {
        wakeAt = Math.min(wakeAt, record.nextAttemptAt);
        continue;
      }
      void this.cancel(client, record);
    }
    for (const record of list) {
      if (!OPEN_STATES.has(record.state)) continue;
      if (this.inFlight.has(record.clientMessageId)) {
        if (record.state === "outbox") break;
        continue;
      }
      if (
        record.state === "queued" &&
        this.host.daemonHolds(record.serverId, record.agentId, record.clientMessageId)
      ) {
        continue;
      }
      if (record.nextAttemptAt > now) {
        wakeAt = Math.min(wakeAt, record.nextAttemptAt);
        if (record.state === "outbox") break;
        continue;
      }
      void this.send(client, record);
      // Later messages wait until this one has a single tick.
      if (record.state === "outbox") break;
    }
    return wakeAt;
  }

  private armTimer(wakeAt: number): void {
    if (wakeAt === Infinity) return;
    if (this.timer !== null && this.timerAt <= wakeAt) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timerAt = wakeAt;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.timerAt = Infinity;
        this.run();
      },
      Math.max(0, wakeAt - this.now()),
    );
  }

  private async send(client: OutboxSendClient, record: OutboxRecord): Promise<void> {
    const id = record.clientMessageId;
    this.inFlight.add(id);
    const attempts = record.attempts + 1;
    try {
      // Saved before the request can reach the socket: from here a delete needs the daemon.
      await updateOutboxRecord(id, {
        attempts,
        everOnWire: true,
        sentAt: record.sentAt ?? this.now(),
        nextAttemptAt: record.state === "outbox" ? 0 : this.now() + SETTLE_RETRY_MS,
      });
      if (getOutboxRecord(id)?.state === "cancelling") return;
      const images = (await this.host.encodeImages(record.images)) ?? [];
      const result = await client.sendAgentMessage(record.agentId, record.text, {
        messageId: id,
        activeTurnBehavior: record.activeTurnBehavior,
        images,
        attachments: record.attachments,
        onReceived: () => {
          if (getOutboxRecord(id)?.state === "outbox")
            void updateOutboxRecord(id, { state: "received" });
        },
      });
      const current = getOutboxRecord(id);
      if (!current || current.state === "cancelling") return;
      const disposition = result ? result.disposition : undefined;
      await updateOutboxRecord(id, {
        state: disposition === "queued" ? "queued" : "taken",
        lastError: undefined,
        nextAttemptAt:
          disposition === "queued"
            ? this.now() + Math.max(SETTLE_RETRY_MS, outboxBackoffMs(attempts, this.random))
            : 0,
      });
    } catch (error) {
      await this.handleSendError(record, error);
    } finally {
      this.inFlight.delete(id);
      this.kick();
    }
  }

  private async handleSendError(record: OutboxRecord, error: unknown): Promise<void> {
    const id = record.clientMessageId;
    const current = getOutboxRecord(id);
    if (!current) return;
    const message = error instanceof Error ? error.message : String(error);
    const kind = classifyOutboxSendError(error);
    if (kind === "cancelled") {
      await removeOutboxRecord(id);
      return;
    }
    if (current.state === "cancelling") return;
    if (kind === "transport") {
      await updateOutboxRecord(id, {
        lastError: message,
        nextAttemptAt: this.now() + outboxBackoffMs(current.attempts, this.random),
      });
      return;
    }
    await updateOutboxRecord(id, {
      state: kind === "unknown" ? "unknown" : "failed",
      lastError: message,
    });
  }

  private async cancel(client: OutboxSendClient, record: OutboxRecord): Promise<void> {
    const id = record.clientMessageId;
    if (!client.cancelAgentMessage) {
      // Old daemon: no cancel. The bubble is hidden; the agent may still get it.
      await removeOutboxRecord(id);
      return;
    }
    this.cancelsInFlight.add(id);
    try {
      const response = await client.cancelAgentMessage(record.agentId, id);
      if (response.result === "too_late") {
        await updateOutboxRecord(id, { state: "taken", deletedTooLate: true, nextAttemptAt: 0 });
      } else {
        await removeOutboxRecord(id);
      }
    } catch (error) {
      if (classifyOutboxSendError(error) === "transport") {
        await updateOutboxRecord(id, {
          lastError: error instanceof Error ? error.message : String(error),
          nextAttemptAt: this.now() + outboxBackoffMs(record.attempts + 1, this.random),
        });
      } else {
        await removeOutboxRecord(id);
      }
    } finally {
      this.cancelsInFlight.delete(id);
      this.kick();
    }
  }

  /**
   * Deletes a pending message. Unsent ones go at once; ones the daemon has or may have are
   * hidden and cancelled through the daemon (or just hidden on a daemon without cancel).
   */
  async delete(clientMessageId: string): Promise<void> {
    const record = getOutboxRecord(clientMessageId);
    if (!record || record.state === "taken") return;
    const unsent =
      record.state === "outbox" && !record.everOnWire && !this.inFlight.has(clientMessageId);
    const settled = record.state === "failed";
    if (unsent || settled || !this.host.features(record.serverId).agentMessageQueue) {
      await removeOutboxRecord(clientMessageId);
      return;
    }
    await updateOutboxRecord(clientMessageId, { state: "cancelling", nextAttemptAt: 0 });
  }

  /** Delete, and hand the text back to the composer. */
  async edit(clientMessageId: string): Promise<void> {
    const record = getOutboxRecord(clientMessageId);
    if (!record || record.state === "taken") return;
    await this.delete(clientMessageId);
    requestOutboxEdit({
      serverId: record.serverId,
      agentId: record.agentId,
      text: record.text,
      attachments: record.composerAttachments,
    });
  }

  /** Send a failed or unknown message again, under a new ID. */
  async resend(clientMessageId: string): Promise<void> {
    const record = getOutboxRecord(clientMessageId);
    if (!record || (record.state !== "failed" && record.state !== "unknown")) return;
    await removeOutboxRecord(clientMessageId);
    await addOutboxRecord({
      serverId: record.serverId,
      agentId: record.agentId,
      clientMessageId: generateMessageId(),
      text: record.text,
      images: record.images,
      attachments: record.attachments,
      composerAttachments: record.composerAttachments,
      activeTurnBehavior: record.activeTurnBehavior,
      createdAt: record.createdAt,
    });
  }

  /** Steer a queued message into the running turn now. */
  async force(serverId: string, agentId: string, clientMessageId: string): Promise<void> {
    const record = getOutboxRecord(clientMessageId);
    if (record && record.state === "outbox" && !record.everOnWire) {
      // Not sent yet: just send it as a steer.
      await updateOutboxRecord(clientMessageId, { activeTurnBehavior: "steer" });
      return;
    }
    const client = this.host.getClient(serverId);
    if (!client?.forceQueuedAgentMessage) return;
    const response = await client.forceQueuedAgentMessage(agentId, clientMessageId);
    if (response.result === "failed") throw new Error(response.error ?? "Could not send now");
    if (record) await updateOutboxRecord(clientMessageId, { nextAttemptAt: 0 });
  }

  /** Delete a message another device queued (it is only in the daemon queue). */
  async cancelRemote(serverId: string, agentId: string, clientMessageId: string): Promise<void> {
    const client = this.host.getClient(serverId);
    if (!client?.cancelAgentMessage) return;
    const response = await client.cancelAgentMessage(agentId, clientMessageId);
    if (response.result === "failed") throw new Error(response.error ?? "Could not delete");
  }
}

let activeSender: OutboxSender | null = null;

export function installOutboxSender(host: OutboxSenderHost): OutboxSender {
  activeSender?.dispose();
  activeSender = new OutboxSender(host);
  activeSender.kick();
  return activeSender;
}

export function getOutboxSender(): OutboxSender | null {
  return activeSender;
}

export interface EnqueueOutboxMessageInput {
  serverId: string;
  agentId: string;
  text: string;
  images: AttachmentMetadata[];
  attachments: AgentAttachment[];
  composerAttachments: OutboxRecord["composerAttachments"];
  activeTurnBehavior: ActiveTurnBehavior;
}

/** Saves the message to the outbox (resolves once on disk) and wakes the sender. */
export async function enqueueOutboxMessage(
  input: EnqueueOutboxMessageInput,
): Promise<OutboxRecord> {
  const record = await addOutboxRecord({
    ...input,
    clientMessageId: generateMessageId(),
    createdAt: Date.now(),
  });
  activeSender?.kick();
  return record;
}
