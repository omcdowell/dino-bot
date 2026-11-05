import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  addOutboxRecord,
  flushOutbox,
  getOutboxRecord,
  hydrateOutbox,
  setOutboxBackingStorageForTests,
  useOutboxStore,
  type OutboxRecord,
} from "@/stores/outbox-store";
import {
  classifyOutboxSendError,
  OutboxSender,
  type OutboxSendClient,
  type OutboxSenderHost,
} from "./sender";

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.writes += 1;
    this.values.set(key, value);
  }
}

interface SendCall {
  agentId: string;
  text: string;
  messageId: string;
  activeTurnBehavior?: string;
  resolve: (value: { disposition?: string }) => void;
  reject: (error: Error) => void;
  received: () => void;
}

class FakeDaemon implements OutboxSendClient {
  readonly calls: SendCall[] = [];
  readonly cancels: Array<{ messageId: string; result: "cancelled" | "too_late" }> = [];
  cancelResult: "cancelled" | "too_late" = "cancelled";
  holds = new Set<string>();

  sendAgentMessage: OutboxSendClient["sendAgentMessage"] = (agentId, text, options) =>
    new Promise((resolve, reject) => {
      this.calls.push({
        agentId,
        text,
        messageId: options.messageId,
        activeTurnBehavior: options.activeTurnBehavior,
        resolve,
        reject,
        received: () => options.onReceived?.(),
      });
    });

  cancelAgentMessage: NonNullable<OutboxSendClient["cancelAgentMessage"]> = async (
    _agentId,
    messageId,
  ) => {
    this.cancels.push({ messageId, result: this.cancelResult });
    return { result: this.cancelResult, error: null };
  };
}

let storage: MemoryStorage;
let daemon: FakeDaemon;
let online: boolean;
let sender: OutboxSender;
let now: number;

function makeSender(overrides: Partial<OutboxSenderHost> = {}): OutboxSender {
  return new OutboxSender({
    getClient: () => daemon,
    isOnline: () => online,
    features: () => ({ messageReceivedAck: true, agentMessageQueue: true }),
    daemonHolds: (_serverId, _agentId, messageId) => daemon.holds.has(messageId),
    encodeImages: async () => [],
    now: () => now,
    random: () => 0.5,
    ...overrides,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  await flushOutbox();
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function write(text: string, overrides: Partial<OutboxRecord> = {}): Promise<OutboxRecord> {
  return addOutboxRecord({
    serverId: "srv",
    agentId: "agent",
    clientMessageId: overrides.clientMessageId ?? `id-${text}`,
    text,
    images: [],
    attachments: [],
    composerAttachments: [],
    activeTurnBehavior: overrides.activeTurnBehavior ?? "queue",
    createdAt: now,
  });
}

beforeEach(() => {
  storage = new MemoryStorage();
  setOutboxBackingStorageForTests(storage);
  daemon = new FakeDaemon();
  online = true;
  now = 1_000_000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  sender = makeSender();
});

afterEach(() => {
  sender.dispose();
  vi.useRealTimers();
});

test("a message is on disk before anything is sent", async () => {
  const saved = write("hello");
  expect(daemon.calls).toHaveLength(0);
  await saved;
  expect(JSON.parse(storage.values.get("paseo-outbox") ?? "{}").records[0].text).toBe("hello");
});

test("ticks follow the daemon: clock, single, grey double, then taken", async () => {
  await write("one");
  await settle();
  expect(daemon.calls).toHaveLength(1);
  expect(getOutboxRecord("id-one")?.state).toBe("outbox");
  expect(getOutboxRecord("id-one")?.everOnWire).toBe(true);

  daemon.calls[0].received();
  await settle();
  expect(getOutboxRecord("id-one")?.state).toBe("received");

  daemon.calls[0].resolve({ disposition: "queued" });
  await settle();
  expect(getOutboxRecord("id-one")?.state).toBe("queued");
});

test("messages go one at a time per agent, in order, each after the previous has a tick", async () => {
  await write("first");
  await write("second");
  await settle();
  expect(daemon.calls.map((call) => call.text)).toEqual(["first"]);

  daemon.calls[0].received();
  await settle();
  expect(daemon.calls.map((call) => call.text)).toEqual(["first", "second"]);
});

test("nothing goes while offline; the online edge sends it", async () => {
  online = false;
  await write("waiting");
  await settle();
  expect(daemon.calls).toHaveLength(0);

  online = true;
  sender.hostOnline("srv");
  await settle();
  expect(daemon.calls).toHaveLength(1);
});

test("transport failures retry for ever with the same ID and payload, backing off", async () => {
  await write("again");
  await settle();
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const call = daemon.calls.at(-1);
    call?.reject(new Error("Connection lost"));
    await settle();
    const record = getOutboxRecord("id-again");
    expect(record?.state).toBe("outbox");
    const wait = (record?.nextAttemptAt ?? 0) - now;
    expect(wait).toBe(Math.min(1000 * 2 ** (attempt - 1), 30_000));
    now += wait;
    await vi.advanceTimersByTimeAsync(wait);
    await settle();
  }
  expect(daemon.calls).toHaveLength(9);
  expect(new Set(daemon.calls.map((call) => call.messageId))).toEqual(new Set(["id-again"]));
  expect(new Set(daemon.calls.map((call) => call.activeTurnBehavior))).toEqual(new Set(["queue"]));
});

test("a definite rejection fails the message; an unknown outcome shows ?", async () => {
  await write("bad");
  await write("odd", { clientMessageId: "id-odd" });
  await settle();
  daemon.calls[0].reject(new Error("agent_request_key_conflict"));
  await settle();
  expect(getOutboxRecord("id-bad")?.state).toBe("failed");
  daemon.calls[1].reject(new Error("agent_request_outcome_unknown"));
  await settle();
  expect(getOutboxRecord("id-odd")?.state).toBe("unknown");
});

test("deleting an unsent message is local; a half-sent one is cancelled through the daemon", async () => {
  online = false;
  await write("unsent");
  await sender.delete("id-unsent");
  expect(getOutboxRecord("id-unsent")).toBeUndefined();

  online = true;
  await write("half");
  await settle();
  daemon.calls[0].received();
  await settle();
  await sender.delete("id-half");
  await settle();
  expect(daemon.cancels.map((cancel) => cancel.messageId)).toEqual(["id-half"]);
  expect(getOutboxRecord("id-half")).toBeUndefined();
});

test("a delete the daemon calls too late leaves the message taken, with a note", async () => {
  daemon.cancelResult = "too_late";
  await write("late");
  await settle();
  daemon.calls[0].received();
  await settle();
  await sender.delete("id-late");
  await settle();
  expect(getOutboxRecord("id-late")).toMatchObject({ state: "taken", deletedTooLate: true });
});

test("a pending delete is never resent and goes before retries", async () => {
  await write("gone");
  await settle();
  daemon.calls[0].received();
  daemon.calls[0].reject(new Error("Connection lost"));
  await settle();
  online = false;
  await sender.delete("id-gone");
  online = true;
  now += 60_000;
  sender.hostOnline("srv");
  await settle();
  expect(daemon.cancels).toHaveLength(1);
  expect(daemon.calls).toHaveLength(1);
});

test("a queued message the daemon still holds is left alone; one it dropped is settled", async () => {
  await write("held");
  await settle();
  daemon.holds.add("id-held");
  daemon.calls[0].resolve({ disposition: "queued" });
  await settle();
  now += 120_000;
  await vi.advanceTimersByTimeAsync(120_000);
  await settle();
  expect(daemon.calls).toHaveLength(1);

  daemon.holds.clear();
  sender.kick();
  await settle();
  expect(daemon.calls).toHaveLength(2);
  daemon.calls[1].resolve({});
  await settle();
  expect(getOutboxRecord("id-held")?.state).toBe("taken");
});

test("saved messages come back after a restart, in order", async () => {
  await write("a");
  await write("b");
  sender.dispose();
  const saved = storage.values.get("paseo-outbox");
  setOutboxBackingStorageForTests(storage);
  storage.values.set("paseo-outbox", saved ?? "");
  expect(useOutboxStore.getState().records).toHaveLength(0);
  await hydrateOutbox();
  expect(useOutboxStore.getState().records.map((record) => record.text)).toEqual(["a", "b"]);
  sender = makeSender();
});

test("error classification", () => {
  expect(classifyOutboxSendError(new Error("Transport not connected (status: disconnected)"))).toBe(
    "transport",
  );
  expect(classifyOutboxSendError(new Error("Request timed out after 60000ms"))).toBe("transport");
  expect(classifyOutboxSendError(new Error("cancelled"))).toBe("cancelled");
  expect(classifyOutboxSendError(new Error("Agent not found"))).toBe("rejected");
});
