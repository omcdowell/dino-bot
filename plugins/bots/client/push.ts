import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { dmsSummaryRpc } from "../shared/dm-rpc";
import { botsPreviewsRpc } from "../shared/home-rpc";
import {
  botsRevRpc,
  PUSH_KINDS,
  PushEventSchema,
  pushEventName,
  REV_CHECK_MS,
  staleKinds,
  type PushKind,
} from "../shared/push-rpc";
import { botsQuietRpc } from "../shared/rpc";
import { botsWorkersRpc } from "../shared/workers-rpc";
import { DMS_KEY, DMS_SUMMARY_KEY } from "./dms-format";

/** `client.events` on Paseo apps with plugin events (older apps: missing). */
export interface BotEvents {
  readonly live: boolean;
  on(name: string, listener: (data: unknown) => void): () => void;
  onLiveChange(listener: (live: boolean) => void): () => void;
}

export const PUSH_KEYS: Record<PushKind, readonly unknown[]> = {
  previews: ["bots", "previews"],
  workers: ["bots", "workers"],
  quiet: ["bots", "quiet"],
  dms: DMS_SUMMARY_KEY,
};
const OUTPUTS = {
  previews: botsPreviewsRpc.output,
  workers: botsWorkersRpc.output,
  quiet: botsQuietRpc.output,
  dms: dmsSummaryRpc.output,
};
/**
 * A prefix of the kind's own key whose other queries its push makes stale: a DMs push carries only
 * the summary, so open thread lists and threads under DMS_KEY refetch (only mounted queries fetch).
 */
const DEPENDENTS: Partial<Record<PushKind, readonly unknown[]>> = { dms: DMS_KEY };

const sameKey = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);

/** A push arrived (its value is in the cache already), or one may have been missed (`pushed` false). */
function refresh(queryClient: QueryClient, kind: PushKind, pushed: boolean): void {
  const own = PUSH_KEYS[kind];
  const dependents = DEPENDENTS[kind];
  if (!pushed) {
    void queryClient.invalidateQueries({ queryKey: dependents ?? own });
    return;
  }
  if (dependents) {
    void queryClient.invalidateQueries({ queryKey: dependents, predicate: (query) => !sameKey(query.queryKey, own) });
  }
}

/**
 * One installation (one host) per plugin bundle evaluation, so this module state is per host:
 * the app's event hub and the revision of the last push applied per kind.
 */
let events: BotEvents | null = null;
const applied: Record<PushKind, number | null> = { previews: null, workers: null, quiet: null, dms: null };
const attached = new Map<QueryClient, { count: number; release: () => void }>();

export function setBotEvents(value: BotEvents | undefined): void {
  events = value ?? null;
}

const subscribeLive = (listener: () => void) => events?.onLiveChange(listener) ?? (() => {});
const getLive = () => events?.live ?? false;

/** Pushes arrive: queries stop polling and lean on the REV_CHECK_MS revision check. */
export function usePushLive(): boolean {
  return useSyncExternalStore(subscribeLive, getLive, getLive);
}

/** Poll interval for a pushed kind: none while pushes arrive, else the old poll. */
export function pollUnlessPushed(pollMs: number) {
  return () => (getLive() ? false : pollMs);
}

/** Pushed values go straight into the query cache; going live refetches what may have been missed. */
export function attach(queryClient: QueryClient, hub: BotEvents): () => void {
  const offs = PUSH_KINDS.map((kind) =>
    hub.on(pushEventName(kind), (raw) => {
      const event = PushEventSchema.safeParse(raw);
      if (!event.success) return;
      const data = OUTPUTS[kind].safeParse(event.data.data);
      if (!data.success) return;
      applied[kind] = event.data.rev;
      queryClient.setQueryData(PUSH_KEYS[kind], data.data);
      refresh(queryClient, kind, true);
    }),
  );
  offs.push(
    hub.onLiveChange((live) => {
      if (!live) return;
      for (const kind of PUSH_KINDS) refresh(queryClient, kind, false);
    }),
  );
  return () => offs.forEach((off) => off());
}

/**
 * Mount wherever bots-home data is shown (sidebar, phone home): wires pushes into this
 * installation's query cache once, and while live runs the revision check that refetches a kind
 * whose push was missed.
 */
export function useBotsPush(): boolean {
  const queryClient = useQueryClient();
  const live = usePushLive();
  useEffect(() => {
    const hub = events;
    if (!hub) return;
    const entry = attached.get(queryClient);
    if (entry) entry.count += 1;
    else attached.set(queryClient, { count: 1, release: attach(queryClient, hub) });
    return () => {
      const current = attached.get(queryClient);
      if (!current || (current.count -= 1) > 0) return;
      current.release();
      attached.delete(queryClient);
    };
  }, [queryClient]);
  const getRev = useRpc(botsRevRpc);
  useQuery({
    queryKey: ["bots", "rev"],
    enabled: live,
    refetchInterval: REV_CHECK_MS,
    staleTime: REV_CHECK_MS / 2,
    queryFn: async () => {
      const answer = await getRev({});
      // Never had a push for this kind: what is on screen came from a fetch, take its revision.
      for (const kind of PUSH_KINDS) applied[kind] ??= answer.revs[kind];
      for (const kind of staleKinds(applied, answer.revs)) {
        applied[kind] = answer.revs[kind];
        refresh(queryClient, kind, false);
      }
      return answer;
    },
  });
  return live;
}
