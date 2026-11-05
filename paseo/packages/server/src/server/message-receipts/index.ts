import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed", "cancelled"]),
  agentId: z.string(),
});
/**
 * What the agent's own history says about a message whose receipt is still pending.
 * - delivered: the agent took it (canonical user message recorded as accepted).
 * - failed: it definitely did not reach the agent; the same id may be sent again.
 * - held: the daemon still holds it (queued, or being handed over); a repeat is a no-op.
 * - unknown: nothing proves either way (e.g. the daemon restarted mid-send).
 */
export type ReceiptResolution = "delivered" | "failed" | "held" | "unknown";

export type ReceiptRecordedState = "new" | "completed";

interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  /** Resolves "held" when the daemon keeps the message for later: the receipt stays pending. */
  send: () => Promise<void | "held">;
  prepare?: () => Promise<void>;
  /** Resolves a pending receipt against the agent's timeline. `error` is set when send() threw. */
  resolve?: (error?: unknown) => ReceiptResolution | Promise<ReceiptResolution>;
  /** Fires once the daemon holds the message durably (or already held it). */
  onRecorded?: (state: ReceiptRecordedState) => void;
}

export type CancelReceiptResult = "cancelled" | "too_late";

export class MessageCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "MessageCancelledError";
  }
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {}

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    return this.chain(key, () => this.sendOnce(key, input));
  }

  /**
   * Cancels a message the agent has not taken. With no receipt yet, a tombstone makes any later
   * send with this id a no-op. `withdraw` takes the message back from wherever the daemon still
   * holds it (the queue) and reports whether it could; it runs inside the per-message chain, so it
   * cannot race a send of the same id.
   */
  cancel(input: {
    agentId: string;
    messageId: string;
    withdraw?: () => boolean | Promise<boolean>;
  }): Promise<CancelReceiptResult> {
    const key = digest(["send", input.agentId, input.messageId]);
    return this.chain(key, async () => {
      const file = path.join(this.directory, `${key}.json`);
      const existing = await readReceipt(file);
      if (existing?.state === "cancelled") return "cancelled";
      if (existing?.state === "completed") return "too_late";
      if (existing?.state === "pending" && !(await input.withdraw?.())) return "too_late";
      await writeJsonFileAtomic(file, {
        fingerprint: existing?.fingerprint ?? "",
        agentId: input.agentId,
        state: "cancelled",
      });
      return "cancelled";
    });
  }

  /** Marks a held (queued) message as taken once its deferred dispatch reached the agent. */
  async complete(agentId: string, messageId: string): Promise<void> {
    const file = path.join(this.directory, `${digest(["send", agentId, messageId])}.json`);
    const existing = await readReceipt(file);
    if (existing?.state !== "pending") return;
    await writeJsonFileAtomic(file, { ...existing, state: "completed" });
  }

  /** Forgets a held message whose deferred dispatch definitely failed, so the id can be retried. */
  async release(agentId: string, messageId: string): Promise<void> {
    const file = path.join(this.directory, `${digest(["send", agentId, messageId])}.json`);
    const existing = await readReceipt(file);
    if (existing?.state === "pending") await rm(file, { force: true });
  }

  /**
   * A provider may have accepted the message before its receipt was committed. Ask the agent's
   * history before giving up: a dropped socket must not strand a delivered message. Returns true
   * when the send is settled; false when the receipt was cleared and the message may go again.
   */
  private async settlePending(
    file: string,
    receipt: { fingerprint: string; agentId: string },
    input: SendMessageInput,
  ): Promise<boolean> {
    const resolution = (await input.resolve?.()) ?? "unknown";
    if (resolution === "unknown") throw new Error("agent_request_outcome_unknown");
    if (resolution === "failed") {
      await rm(file, { force: true });
      return false;
    }
    if (resolution === "delivered") {
      await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
    }
    input.onRecorded?.("completed");
    return true;
  }

  private chain<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(key, settled);
    void settled.finally(() => {
      if (this.pending.get(key) === settled) this.pending.delete(key);
    });
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const receipt = { fingerprint, agentId: input.agentId };
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.state === "cancelled") throw new MessageCancelledError();
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") {
        input.onRecorded?.("completed");
        return;
      }
      if (await this.settlePending(file, receipt, input)) return;
    }
    await input.prepare?.();
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    input.onRecorded?.("new");
    let outcome: void | "held";
    try {
      outcome = await input.send();
    } catch (error) {
      const resolution = (await input.resolve?.(error)) ?? "unknown";
      if (resolution === "delivered") {
        await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
        return;
      }
      // A definite failure must not block a retry with the same id.
      if (resolution === "failed") await rm(file, { force: true });
      throw error;
    }
    if (outcome === "held") return;
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
