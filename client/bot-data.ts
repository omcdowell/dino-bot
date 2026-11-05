import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { botsPreviewsRpc, PREVIEWS_POLL_MS, type BotPreview } from "../shared/home-rpc";
import { botsAvatarPackRpc } from "../shared/avatar-rpc";
import { botsListRpc, botsQuietRpc, QUIET_POLL_MS } from "../shared/rpc";
import { botsWorkersRpc, outstandingCount, stalledCount, WORKERS_POLL_MS } from "../shared/workers-rpc";
import { botStatus, quietApplies, type BotStatus } from "./status";
import { pollUnlessPushed, useBotsPush } from "./push";
import { updateAvatarPack, type FetchPack } from "./avatar-pack-store";

export const BOTS_QUERY_KEY = ["bots", "list"] as const;
export const BOTS_WORKERS_KEY = ["bots", "workers"] as const;
export const BOTS_QUIET_KEY = ["bots", "quiet"] as const;
export const BOTS_PREVIEWS_KEY = ["bots", "previews"] as const;

export type PreviewRow = { preview: BotPreview | null; turnStartedAt: string | null; activityAt?: string | null };
export type Previews = { rows: ReadonlyMap<string, PreviewRow>; fetchedAt: number };

/**
 * Each bot's latest preview and last activity (`bots.previews`): one cached query shared by the
 * phone home and the desktop sidebar. Pushed by the host when it changes (client/push.ts); on
 * hosts or apps without plugin events, polled every PREVIEWS_POLL_MS while on screen. Refetched
 * early when a row's status changes (`useRefreshPreviewsOnChange`).
 */
export function usePreviews() {
  useBotsPush();
  const getPreviews = useRpc(botsPreviewsRpc);
  const query = useQuery({
    queryKey: BOTS_PREVIEWS_KEY,
    queryFn: () => getPreviews({}),
    staleTime: 5_000,
    refetchInterval: pollUnlessPushed(PREVIEWS_POLL_MS),
    meta: { persist: true },
  });
  const previews: Previews = {
    rows: new Map((query.data?.bots ?? []).map((row) => [row.botId, row])),
    fetchedAt: query.dataUpdatedAt,
  };
  return { previews, refetch: query.refetch };
}

/** A row's status changed (a turn started or ended): ask for fresh previews, so the order and line follow. */
export function useRefreshPreviewsOnChange(status: BotStatus) {
  const queryClient = useQueryClient();
  const previous = useRef<BotStatus | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== status) {
      void queryClient.invalidateQueries({ queryKey: BOTS_PREVIEWS_KEY });
    }
    previous.current = status;
  }, [status, queryClient]);
}

export type QuietAnswer = { ids: ReadonlySet<string>; fetchedAt: number };

/** Bots, their outstanding herdr workers and the DM-only answer: shared by the sidebar and the phone home. */
export function useBotsData() {
  useBotsPush();
  const listBots = useRpc(botsListRpc);
  const list = useQuery({
    queryKey: BOTS_QUERY_KEY,
    queryFn: () => listBots({}),
    staleTime: 30_000,
    refetchInterval: 60_000,
    // Kept on the device by the app (phone home cache), so a cold start shows the last known list.
    meta: { persist: true },
  });
  // The host has a newer avatar options pack: fetch it once in the background (used next open).
  const queryClient = useQueryClient();
  const getPack = useRpc(botsAvatarPackRpc);
  const serverPack = list.isFetchedAfterMount ? list.data?.avatarPackVersion : undefined;
  useEffect(() => {
    if (serverPack === undefined) return;
    // The pack as JSON text: the phone has no gunzip.
    const fetchPack: FetchPack = async ({ have }) => {
      const answer = await getPack({ have, format: "json" });
      return { packVersion: answer.packVersion, json: answer.json ?? null };
    };
    void updateAvatarPack(queryClient, serverPack, fetchPack);
  }, [serverPack, queryClient]);
  const listWorkers = useRpc(botsWorkersRpc);
  const workers = useQuery({
    queryKey: BOTS_WORKERS_KEY,
    queryFn: () => listWorkers({}),
    staleTime: 5_000,
    refetchInterval: pollUnlessPushed(WORKERS_POLL_MS),
  });
  const listQuiet = useRpc(botsQuietRpc);
  const quietQuery = useQuery({
    queryKey: BOTS_QUIET_KEY,
    queryFn: () => listQuiet({}),
    staleTime: 5_000,
    refetchInterval: pollUnlessPushed(QUIET_POLL_MS),
  });
  const quiet: QuietAnswer = { ids: new Set(quietQuery.data?.agentIds ?? []), fetchedAt: quietQuery.dataUpdatedAt };
  const workerCounts = new Map((workers.data?.bots ?? []).map((b) => [b.botId, outstandingCount(b.workers)]));
  const stalledCounts = new Map((workers.data?.bots ?? []).map((b) => [b.botId, stalledCount(b.workers)]));
  return {
    bots: list.data?.bots ?? [],
    isLoading: list.isLoading,
    error: list.error,
    /** The list on screen came from the device cache and the host has not answered since. */
    lastKnown: !!list.data && !list.isFetchedAfterMount,
    workerCounts,
    /** Workers per bot that stopped on an error without reporting. */
    stalledCounts,
    quiet,
    refetch: () => Promise.all([list.refetch(), workers.refetch(), quietQuery.refetch()]),
  };
}

/**
 * A bot row's status from the app's live agent state (no extra network subscription), with the
 * DM-only rule: when the attention flag switches on, ask the server again whether only DMs started
 * the turn; until it answers, the dot shows (an older "quiet" answer is not applied).
 */
export function useBotRowStatus(agentId: string | null, workers: number, quiet: QuietAnswer, stalled = 0) {
  const snapshot = useAgent(agentId ?? "", (agent) => ({
    status: agent.status,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
    lastActivityAt: agent.lastActivityAt,
    // Present on Paseo builds with the phone home (older hosts: undefined).
    pendingPermissionCount: (agent as { pendingPermissionCount?: number }).pendingPermissionCount ?? 0,
  }));
  const queryClient = useQueryClient();
  const flagOnSince = useRef(0);
  const flag = !!snapshot?.requiresAttention;
  useEffect(() => {
    if (!flag) return;
    flagOnSince.current = Date.now();
    void queryClient.invalidateQueries({ queryKey: BOTS_QUIET_KEY });
  }, [flag, queryClient]);
  const dmOnly = quietApplies(quiet.ids, agentId, quiet.fetchedAt, flagOnSince.current);
  const status: BotStatus = agentId ? botStatus(snapshot, workers, dmOnly, stalled) : "none";
  return { status, lastActivityAt: snapshot?.lastActivityAt ?? null, live: !!snapshot || !agentId };
}
