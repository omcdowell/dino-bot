/**
 * The avatar.json calls the designer makes to the host: AV1's `bots.avatar-save` and `bots.avatar-json`
 * (shared/avatar-rpc.ts), adapted to the outbox's shapes (spec §3: a save with a revision <= the stored one is
 * refused and the reply carries the stored revision):
 *   save  { botId, avatar: AvatarJson } -> { ok: true, revision, hash? } | { ok: false, reason: "stale", currentRevision }
 *                                          | { ok: false, reason: "invalid", error }
 *   get   { botId } -> { avatar: AvatarJson | null }
 * A thrown error (offline, timeout, host restarting, a host without AV1) means "not sent": the save stays
 * queued on the device and is retried later; the designer opens on the device's own copy.
 */
import { useRpc } from "@getpaseo/plugin/client";
import type { AvatarJson } from "../shared/avatar";
import { botsAvatarJsonRpc, botsAvatarSaveRpc, type SaveAvatarResultWire } from "../shared/avatar-rpc";

export type AvatarSaveInput = { botId: string; avatar: AvatarJson };
export type AvatarSaveResult =
  | { ok: true; revision: number; hash?: string | null }
  | { ok: false; reason: "stale"; currentRevision: number }
  | { ok: false; reason: "invalid"; error: string };
export type AvatarGetResult = { avatar: AvatarJson | null };

export interface AvatarApi {
  save(input: AvatarSaveInput): Promise<AvatarSaveResult>;
  get(input: { botId: string }): Promise<AvatarGetResult>;
}

export class AvatarApiUnavailable extends Error {
  constructor() {
    super("This host cannot save avatar.json yet");
    this.name = "AvatarApiUnavailable";
  }
}

/** Nothing reaches the host; saves wait in the outbox (tests, and before AV1 was wired). */
export const STUB_AVATAR_API: AvatarApi = {
  save: () => Promise.reject(new AvatarApiUnavailable()),
  get: () => Promise.reject(new AvatarApiUnavailable()),
};

/** AV1's save answer (`bots.avatar-save`) as the outbox's AvatarSaveResult. */
export function fromSaveWire(wire: SaveAvatarResultWire): AvatarSaveResult {
  if (wire.reason === "saved") return { ok: true, revision: wire.revision, hash: wire.hash };
  if (wire.reason === "stale") return { ok: false, reason: "stale", currentRevision: wire.revision };
  return { ok: false, reason: "invalid", error: wire.error };
}

/** Adapts AV1's two RPC callers (as `useRpc` returns them) to AvatarApi. */
export function useAvatarApiFrom(
  save: (input: AvatarSaveInput) => Promise<SaveAvatarResultWire>,
  get: (input: { botId: string }) => Promise<AvatarGetResult>,
): AvatarApi {
  return {
    save: async (input) => fromSaveWire(await save(input)),
    get: async (input) => ({ avatar: (await get(input)).avatar ?? null }),
  };
}

/** The host's avatar.json calls (AV1: bots.avatar-save, bots.avatar-json). */
export function useAvatarApi(): AvatarApi {
  return useAvatarApiFrom(useRpc(botsAvatarSaveRpc), useRpc(botsAvatarJsonRpc));
}
