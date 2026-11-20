import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import { useDraftStore } from "@/stores/draft-store";
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
  outboxUploadPercent,
  useOutboxUploadProgress,
  type OutboxUploadProgress,
} from "./image-uploads";
import {
  classifyOutboxSendError,
  INLINE_TOO_LARGE_MESSAGE,
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
  dictated?: boolean;
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
        ...("dictated" in options ? { dictated: options.dictated } : {}),
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
    ...(overrides.dictated ? { dictated: true } : {}),
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

test("a dictated message is sent as dictated, on disk and on every attempt; a typed one is not", async () => {
  await write("spoken", { dictated: true });
  await write("typed", { activeTurnBehavior: "queue" });
  expect(
    JSON.parse(storage.values.get("paseo-outbox") ?? "{}").records.map(
      (record: OutboxRecord) => record.dictated,
    ),
  ).toEqual([true, undefined]);
  await settle();
  expect(daemon.calls[0]).toMatchObject({ text: "spoken", dictated: true });
  daemon.calls[0].reject(new Error("Connection lost"));
  await settle();
  const wait = (getOutboxRecord("id-spoken")?.nextAttemptAt ?? 0) - now;
  now += wait;
  await vi.advanceTimersByTimeAsync(wait);
  await settle();
  const spoken = daemon.calls.filter((call) => call.text === "spoken");
  expect(spoken.length).toBeGreaterThan(1);
  expect(spoken.every((call) => call.dictated === true)).toBe(true);
  spoken.at(-1)!.resolve({ disposition: "queued" });
  await settle();
  const typed = daemon.calls.find((call) => call.text === "typed");
  expect(typed).toBeDefined();
  expect(typed && "dictated" in typed).toBe(false);
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

test("OQ1: sent before the host ever connected (no client yet), they go in order, once each, on connect", async () => {
  sender.dispose();
  let client: FakeDaemon | null = null;
  online = false;
  sender = makeSender({ getClient: () => client });
  await write("first");
  await write("second");
  await settle();
  expect(useOutboxStore.getState().records.map((record) => record.state)).toEqual([
    "outbox",
    "outbox",
  ]);

  client = daemon;
  online = true;
  sender.hostOnline("srv");
  sender.hostOnline("srv");
  sender.kick();
  await settle();
  expect(daemon.calls.map((call) => call.text)).toEqual(["first"]);

  daemon.calls[0].received();
  daemon.calls[0].resolve({});
  await settle();
  expect(daemon.calls.map((call) => call.text)).toEqual(["first", "second"]);
  daemon.calls[1].reject(new Error("agent_not_found"));
  await settle();
  sender.kick();
  await settle();

  expect(daemon.calls.map((call) => call.messageId)).toEqual(["id-first", "id-second"]);
  expect(getOutboxRecord("id-first")?.state).toBe("taken");
  // Rejected after reconnect: failed state, text kept for Resend/Edit.
  expect(getOutboxRecord("id-second")).toMatchObject({ state: "failed", text: "second" });
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

// Edit (EV1): the text goes back into the composer draft before the message is deleted, on
// every path; if it cannot go back, the message stays.

const DRAFT_KEY = "agent:srv:agent";

function draftText(): string | undefined {
  return useDraftStore.getState().getDraftInput(DRAFT_KEY)?.text;
}

const IMAGE: AttachmentMetadata = {
  id: "img-1",
  mimeType: "image/png",
  storageType: "native-file",
  storageKey: "img-1.png",
  createdAt: 1,
};

async function writeWithImage(text: string): Promise<OutboxRecord> {
  return addOutboxRecord({
    serverId: "srv",
    agentId: "agent",
    clientMessageId: `id-${text}`,
    text,
    images: [IMAGE],
    attachments: [],
    composerAttachments: [{ kind: "image", metadata: IMAGE }],
    activeTurnBehavior: "queue",
    createdAt: now,
  });
}

describe("edit", () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {} });
  });

  test("an unsent message (offline, clock) goes back to the composer with its image", async () => {
    online = false;
    await writeWithImage("unsent");
    await settle();
    await sender.edit("id-unsent");
    await settle();
    expect(getOutboxRecord("id-unsent")).toBeUndefined();
    expect(draftText()).toBe("unsent");
    expect(useDraftStore.getState().getDraftInput(DRAFT_KEY)?.attachments).toEqual([
      { kind: "image", metadata: IMAGE },
    ]);
    expect(useOutboxStore.getState().editRequest).toMatchObject({
      serverId: "srv",
      agentId: "agent",
    });
  });

  test("a message the daemon queued (grey ticks) goes back and is cancelled through the daemon", async () => {
    await write("queued");
    await settle();
    daemon.calls[0].resolve({ disposition: "queued" });
    await settle();
    expect(getOutboxRecord("id-queued")?.state).toBe("queued");

    await sender.edit("id-queued");
    await settle();
    expect(draftText()).toBe("queued");
    expect(daemon.cancels.map((cancel) => cancel.messageId)).toEqual(["id-queued"]);
    expect(getOutboxRecord("id-queued")).toBeUndefined();
  });

  test("a message in flight (single tick) goes back; a too-late cancel keeps the text too", async () => {
    daemon.cancelResult = "too_late";
    await write("inflight");
    await settle();
    daemon.calls[0].received();
    await settle();
    await sender.edit("id-inflight");
    await settle();
    expect(draftText()).toBe("inflight");
    expect(getOutboxRecord("id-inflight")?.deletedTooLate).toBe(true);
  });

  test("a failed message goes back to the composer", async () => {
    await write("bad");
    await settle();
    daemon.calls[0].reject(new Error("agent_request_key_conflict"));
    await settle();
    await sender.edit("id-bad");
    await settle();
    expect(draftText()).toBe("bad");
    expect(getOutboxRecord("id-bad")).toBeUndefined();
  });

  test("an old daemon without a queue: the message goes back and is hidden", async () => {
    sender.dispose();
    sender = makeSender({
      features: () => ({ messageReceivedAck: true, agentMessageQueue: false }),
    });
    await write("old");
    await settle();
    daemon.calls[0].resolve({ disposition: "queued" });
    await settle();
    await sender.edit("id-old");
    await settle();
    expect(draftText()).toBe("old");
    expect(getOutboxRecord("id-old")).toBeUndefined();
  });

  test("what is already being typed stays; the edited message follows it", async () => {
    online = false;
    useDraftStore.getState().saveDraftInput({
      draftKey: DRAFT_KEY,
      draft: { text: "half typed", attachments: [] },
    });
    await write("pending");
    await sender.edit("id-pending");
    await settle();
    expect(draftText()).toBe("half typed\n\npending");
  });

  test("the text lands even when no composer for the agent is mounted", async () => {
    // Nothing subscribes to the edit request here: the draft alone carries the text, and the
    // composer shows it when the chat opens.
    online = false;
    await write("later");
    await sender.edit("id-later");
    await settle();
    expect(draftText()).toBe("later");
  });

  test("if the text cannot go back, the message is not deleted", async () => {
    sender.dispose();
    sender = makeSender({
      restoreForEdit: async () => {
        throw new Error("draft unavailable");
      },
    });
    await write("keep");
    await settle();
    daemon.calls[0].resolve({ disposition: "queued" });
    await settle();
    await expect(sender.edit("id-keep")).rejects.toThrow("draft unavailable");
    await settle();
    expect(getOutboxRecord("id-keep")?.state).toBe("queued");
    expect(daemon.cancels).toHaveLength(0);
  });

  test("taken and already-cancelling messages are not edited", async () => {
    await write("gone");
    await settle();
    daemon.calls[0].resolve({});
    await settle();
    expect(getOutboxRecord("id-gone")?.state).toBe("taken");
    await sender.edit("id-gone");
    await settle();
    expect(draftText()).toBeUndefined();
  });
});

describe("photos (UF1)", () => {
  const photo = (n: number, byteSize = 1000): AttachmentMetadata => ({
    id: `photo-${n}`,
    mimeType: "image/jpeg",
    storageType: "native-file",
    storageKey: `photo-${n}.jpg`,
    fileName: `test-photo-${n}.jpg`,
    byteSize,
    createdAt: 1,
  });

  interface UploadCall {
    fileName: string;
    byteLength: number;
    progressSeen: OutboxUploadProgress | undefined;
  }

  class UploadingDaemon extends FakeDaemon {
    readonly uploads: UploadCall[] = [];
    readonly photoOptions: Array<{ images?: unknown[]; imageUploads?: unknown[] }> = [];
    failUploadAt: number | null = null;
    failWith: { kind: "throw"; message: string } | { kind: "error"; message: string } = {
      kind: "throw",
      message: "Connection lost",
    };

    constructor() {
      super();
      const send = this.sendAgentMessage;
      this.sendAgentMessage = (agentId, text, options) => {
        this.photoOptions.push({ images: options.images, imageUploads: options.imageUploads });
        return send(agentId, text, options);
      };
    }

    // A prototype method that uses `this`, like DaemonClient.uploadFile: the sender must call it
    // on the client, not as a detached function (it failed with "undefined is not a function").
    async uploadFile(
      input: Parameters<NonNullable<OutboxSendClient["uploadFile"]>>[0],
    ): ReturnType<NonNullable<OutboxSendClient["uploadFile"]>> {
      const n = this.uploads.length + 1;
      if (this.failUploadAt === n) {
        this.failUploadAt = null;
        if (this.failWith.kind === "throw") throw new Error(this.failWith.message);
        return { file: null, error: this.failWith.message };
      }
      input.onProgress?.(input.bytes.byteLength / 2, input.bytes.byteLength);
      this.uploads.push({
        fileName: input.fileName,
        byteLength: input.bytes.byteLength,
        progressSeen: Object.values(useOutboxUploadProgress.getState())[0],
      });
      input.onProgress?.(input.bytes.byteLength, input.bytes.byteLength);
      return {
        file: { id: `upload_${n}`, fileName: input.fileName, mimeType: input.mimeType },
        error: null,
      };
    }
  }

  async function settleUploads(): Promise<void> {
    for (let round = 0; round < 6; round += 1) await settle();
  }

  let uploading: UploadingDaemon;
  const reads: string[] = [];
  const remembered: string[] = [];

  async function writePhotos(text: string, images: AttachmentMetadata[]): Promise<void> {
    await addOutboxRecord({
      serverId: "srv",
      agentId: "agent",
      clientMessageId: `id-${text}`,
      text,
      images,
      attachments: [],
      composerAttachments: images.map((metadata) => ({ kind: "image" as const, metadata })),
      activeTurnBehavior: "queue",
      createdAt: now,
    });
  }

  beforeEach(() => {
    sender.dispose();
    uploading = new UploadingDaemon();
    daemon = uploading;
    reads.length = 0;
    remembered.length = 0;
    sender = makeSender({
      features: () => ({ messageReceivedAck: true, agentMessageQueue: true, imageUploads: true }),
      encodeImages: async () => {
        throw new Error("photos must not go inline to an imageUploads host");
      },
      readImageBytes: async (image) => {
        reads.push(image.id);
        return new Uint8Array(image.byteSize ?? 0);
      },
      onImageBytes: async (image) => {
        remembered.push(image.id);
      },
    });
  });

  test("each photo goes up on its own with progress; the message names the uploads only", async () => {
    await writePhotos("pics", [photo(1, 400), photo(2, 800), photo(3, 200)]);
    await settleUploads();

    expect(uploading.uploads.map((upload) => [upload.fileName, upload.byteLength])).toEqual([
      ["test-photo-1.jpg", 400],
      ["test-photo-2.jpg", 800],
      ["test-photo-3.jpg", 200],
    ]);
    expect(uploading.uploads.map((upload) => upload.progressSeen)).toEqual([
      { index: 1, count: 3, sentBytes: 200, totalBytes: 400 },
      { index: 2, count: 3, sentBytes: 400, totalBytes: 800 },
      { index: 3, count: 3, sentBytes: 100, totalBytes: 200 },
    ]);
    expect(remembered).toEqual(["photo-1", "photo-2", "photo-3"]);
    expect(uploading.photoOptions).toEqual([
      {
        images: [],
        imageUploads: [
          { id: "upload_1", fileName: "test-photo-1.jpg", mimeType: "image/jpeg" },
          { id: "upload_2", fileName: "test-photo-2.jpg", mimeType: "image/jpeg" },
          { id: "upload_3", fileName: "test-photo-3.jpg", mimeType: "image/jpeg" },
        ],
      },
    ]);

    uploading.calls[0]?.resolve({ disposition: "taken" });
    await settleUploads();
    expect(getOutboxRecord("id-pics")?.state).toBe("taken");
    expect(useOutboxUploadProgress.getState()).toEqual({});
  });

  test("a dropped connection mid-upload retries, sending only the photos not yet up", async () => {
    uploading.failUploadAt = 3;
    await writePhotos("retry", [photo(1), photo(2), photo(3), photo(4)]);
    await settleUploads();

    const record = getOutboxRecord("id-retry");
    expect(record?.state).toBe("outbox");
    expect(record?.lastError).toBe("Connection lost");
    expect(Object.keys(record?.uploadedImages ?? {})).toEqual(["photo-1", "photo-2"]);
    expect(uploading.calls).toHaveLength(0);
    expect(useOutboxUploadProgress.getState()).toEqual({});

    const wait = (record?.nextAttemptAt ?? 0) - now;
    now += wait;
    await vi.advanceTimersByTimeAsync(wait);
    await settleUploads();

    expect(reads).toEqual(["photo-1", "photo-2", "photo-3", "photo-3", "photo-4"]);
    expect(uploading.photoOptions[0]?.imageUploads).toHaveLength(4);
    uploading.calls[0]?.resolve({ disposition: "taken" });
    await settleUploads();
    expect(getOutboxRecord("id-retry")?.state).toBe("taken");
  });

  test("an upload the host refuses fails the message visibly, ready to resend", async () => {
    uploading.failUploadAt = 1;
    uploading.failWith = { kind: "error", message: "No space left on host" };
    await writePhotos("refused", [photo(1)]);
    await settleUploads();
    expect(getOutboxRecord("id-refused")).toMatchObject({
      state: "failed",
      lastError: "No space left on host",
    });
    expect(uploading.calls).toHaveLength(0);
  });

  test("an old host gets the photos inline, but never a frame too big for its socket", async () => {
    sender.dispose();
    const encoded: string[][] = [];
    sender = makeSender({
      encodeImages: async (images) => {
        encoded.push(images.map((image) => image.id));
        return images.map(() => ({ data: "AAAA", mimeType: "image/jpeg" }));
      },
    });

    await writePhotos("small", [photo(1, 5_000_000), photo(2, 5_000_000)]);
    await settleUploads();
    expect(encoded).toEqual([["photo-1", "photo-2"]]);
    expect(uploading.uploads).toHaveLength(0);
    uploading.calls[0]?.resolve({ disposition: "taken" });
    await settleUploads();

    const big = Array.from({ length: 16 }, (_, i) => photo(i + 10, 6_700_000));
    await writePhotos("big", big);
    await settleUploads();
    expect(encoded).toHaveLength(1);
    expect(getOutboxRecord("id-big")).toMatchObject({
      state: "failed",
      lastError: INLINE_TOO_LARGE_MESSAGE,
    });
  });

  test("upload percent counts finished photos as whole", () => {
    expect(outboxUploadPercent({ index: 1, count: 4, sentBytes: 0, totalBytes: 100 })).toBe(0);
    expect(outboxUploadPercent({ index: 2, count: 4, sentBytes: 50, totalBytes: 100 })).toBe(37);
    expect(outboxUploadPercent({ index: 4, count: 4, sentBytes: 100, totalBytes: 100 })).toBe(100);
    expect(outboxUploadPercent({ index: 1, count: 0, sentBytes: 0, totalBytes: 0 })).toBe(0);
  });
});
