import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { z } from "zod";
import type { ActiveTurnBehavior, AgentAttachment } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";

/**
 * Saved outbox: every message the user sends to an agent is written here first, before the
 * composer clears and before anything goes on the wire, and stays until the agent has taken it
 * (the canonical user_message with the same clientMessageId is in the stream) or the user
 * deletes it. Survives app restarts; the sender (composer/outbox/sender.ts) delivers it.
 *
 * States, matching the ticks:
 * - outbox: clock. Only on this device as far as we know.
 * - received: single tick. The daemon has recorded it.
 * - queued: grey double tick. The daemon holds it until the agent is idle.
 * - taken: blue double tick. The agent has it; waiting for the canonical row to replace the bubble.
 * - failed: red "!". Definitely rejected.
 * - unknown: "?". The daemon cannot say what happened.
 * - cancelling: hidden; a delete is waiting for the daemon to confirm.
 */
export type OutboxState =
  | "outbox"
  | "received"
  | "queued"
  | "taken"
  | "failed"
  | "unknown"
  | "cancelling";

export interface OutboxRecord {
  serverId: string;
  agentId: string;
  clientMessageId: string;
  text: string;
  /** Wire form, fixed at write time so every retry sends an identical payload. */
  images: AttachmentMetadata[];
  attachments: AgentAttachment[];
  /** Composer form, only used to put the message back into the composer on Edit. */
  composerAttachments: ComposerAttachment[];
  activeTurnBehavior: ActiveTurnBehavior;
  /** Some of the text was dictated: sent as `dictated` every attempt. */
  dictated?: boolean;
  createdAt: number;
  sentAt?: number;
  attempts: number;
  /** True once a request may have reached the daemon: deleting it then needs a daemon cancel. */
  everOnWire: boolean;
  nextAttemptAt: number;
  state: OutboxState;
  lastError?: string;
  /** A delete reached the daemon after the agent had taken the message. */
  deletedTooLate?: boolean;
}

/** An Edit put a message back into this agent's composer draft; mounted composers show it. */
export interface OutboxEditRequest {
  serverId: string;
  agentId: string;
  id: number;
}

interface OutboxStoreState {
  hydrated: boolean;
  records: OutboxRecord[];
  /** The last Edit that put a pinned bubble's text back in a composer draft. */
  editRequest: OutboxEditRequest | null;
}

export const OUTBOX_STORAGE_KEY = "paseo-outbox";
const OUTBOX_VERSION = 1;
const TAKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

const PersistedOutboxSchema = z.object({
  version: z.literal(OUTBOX_VERSION),
  records: z.array(
    z
      .object({
        serverId: z.string(),
        agentId: z.string(),
        clientMessageId: z.string(),
        text: z.string(),
        images: z.array(z.any()),
        attachments: z.array(z.any()),
        composerAttachments: z.array(z.any()),
        activeTurnBehavior: z.enum(["interrupt", "steer", "queue"]),
        createdAt: z.number(),
        sentAt: z.number().optional(),
        attempts: z.number(),
        everOnWire: z.boolean(),
        nextAttemptAt: z.number(),
        state: z.enum(["outbox", "received", "queued", "taken", "failed", "unknown", "cancelling"]),
        lastError: z.string().optional(),
        deletedTooLate: z.boolean().optional(),
        dictated: z.boolean().optional(),
      })
      .passthrough(),
  ),
});

export const useOutboxStore = create<OutboxStoreState>(() => ({
  hydrated: false,
  records: [],
  editRequest: null,
}));

interface OutboxBackingStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

let backingStorage: OutboxBackingStorage = AsyncStorage;
let writeChain: Promise<void> = Promise.resolve();
let hydration: Promise<void> | null = null;
const attachmentReleases = new Map<string, Array<() => void>>();
const listeners = new Set<() => void>();

/** Tests only. */
export function setOutboxBackingStorageForTests(storage: OutboxBackingStorage): void {
  backingStorage = storage;
  writeChain = Promise.resolve();
  hydration = null;
  for (const releases of attachmentReleases.values()) for (const release of releases) release();
  attachmentReleases.clear();
  useOutboxStore.setState({ hydrated: false, records: [], editRequest: null });
}

/** Called after every change to the records, so the sender can look again. */
export function onOutboxChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function retainImages(record: OutboxRecord): void {
  if (attachmentReleases.has(record.clientMessageId) || record.images.length === 0) return;
  attachmentReleases.set(
    record.clientMessageId,
    record.images.map((image) => retainAttachmentForGarbageCollection(image.id)),
  );
}

function releaseImages(clientMessageId: string): void {
  for (const release of attachmentReleases.get(clientMessageId) ?? []) release();
  attachmentReleases.delete(clientMessageId);
}

function persist(): Promise<void> {
  const snapshot = JSON.stringify({
    version: OUTBOX_VERSION,
    records: useOutboxStore.getState().records,
  });
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => backingStorage.setItem(OUTBOX_STORAGE_KEY, snapshot));
  return writeChain;
}

function commit(records: OutboxRecord[]): Promise<void> {
  useOutboxStore.setState({ records });
  const saved = persist();
  for (const listener of listeners) listener();
  return saved;
}

/** Loads saved records once. Records saved while loading are kept after the loaded ones. */
export function hydrateOutbox(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    let loaded: OutboxRecord[] = [];
    try {
      const raw = await backingStorage.getItem(OUTBOX_STORAGE_KEY);
      if (raw) {
        const parsed = PersistedOutboxSchema.safeParse(JSON.parse(raw));
        if (parsed.success) loaded = parsed.data.records as OutboxRecord[];
      }
    } catch (error) {
      console.warn("[Outbox] failed to load saved messages", error);
    }
    const current = useOutboxStore.getState().records;
    const currentIds = new Set(current.map((record) => record.clientMessageId));
    // A request in flight when the app died may have reached the daemon. Retrying with the
    // same ID is safe (the daemon dedupes), so everything unfinished goes back to the sender.
    // Taken messages wait for their canonical row to replace the bubble; a day is plenty.
    const takenCutoff = Date.now() - TAKEN_RETENTION_MS;
    const restored = loaded.filter(
      (record) =>
        !currentIds.has(record.clientMessageId) &&
        !(record.state === "taken" && (record.sentAt ?? record.createdAt) < takenCutoff),
    );
    for (const record of restored) retainImages(record);
    useOutboxStore.setState({ hydrated: true, records: [...restored, ...current] });
    if (restored.length > 0) await persist();
    for (const listener of listeners) listener();
  })();
  return hydration;
}

export function getOutboxRecord(clientMessageId: string): OutboxRecord | undefined {
  return useOutboxStore
    .getState()
    .records.find((record) => record.clientMessageId === clientMessageId);
}

export function listOutboxRecords(serverId: string, agentId?: string): OutboxRecord[] {
  return useOutboxStore
    .getState()
    .records.filter(
      (record) =>
        record.serverId === serverId && (agentId === undefined || record.agentId === agentId),
    );
}

/** Saves a new message. Resolves once it is on disk; only then may the composer clear. */
export function addOutboxRecord(
  input: Omit<OutboxRecord, "attempts" | "everOnWire" | "nextAttemptAt" | "state">,
): Promise<OutboxRecord> {
  const record: OutboxRecord = {
    ...input,
    attempts: 0,
    everOnWire: false,
    nextAttemptAt: 0,
    state: "outbox",
  };
  retainImages(record);
  return commit([...useOutboxStore.getState().records, record]).then(() => record);
}

export function updateOutboxRecord(
  clientMessageId: string,
  patch: Partial<Omit<OutboxRecord, "clientMessageId" | "serverId" | "agentId">>,
): Promise<void> {
  const records = useOutboxStore.getState().records;
  const index = records.findIndex((record) => record.clientMessageId === clientMessageId);
  if (index < 0) return Promise.resolve();
  const next = records.slice();
  next[index] = { ...records[index], ...patch };
  return commit(next);
}

export function removeOutboxRecord(clientMessageId: string): Promise<void> {
  const records = useOutboxStore.getState().records;
  if (!records.some((record) => record.clientMessageId === clientMessageId)) {
    return Promise.resolve();
  }
  releaseImages(clientMessageId);
  return commit(records.filter((record) => record.clientMessageId !== clientMessageId));
}

/** The canonical rows for these IDs are in the stream: the bubbles have moved there. */
export function settleOutboxRecordsSeenInStream(clientMessageIds: Iterable<string>): void {
  const seen = new Set(clientMessageIds);
  const records = useOutboxStore.getState().records;
  if (!records.some((record) => seen.has(record.clientMessageId))) return;
  for (const record of records) {
    if (seen.has(record.clientMessageId)) releaseImages(record.clientMessageId);
  }
  void commit(records.filter((record) => !seen.has(record.clientMessageId)));
}

let editRequestId = 0;

/**
 * Tells every composer mounted for the agent to show its draft again (an Edit wrote to it).
 * Not consumed: with the same chat mounted twice (a screen under the one on show), the first
 * composer to look must not take it from the one the user sees.
 */
export function requestOutboxEdit(request: Omit<OutboxEditRequest, "id">): void {
  editRequestId += 1;
  useOutboxStore.setState({ editRequest: { ...request, id: editRequestId } });
}

/** Waits for pending writes (tests and shutdown). */
export function flushOutbox(): Promise<void> {
  return writeChain.catch(() => undefined);
}
