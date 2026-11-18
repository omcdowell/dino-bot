import type { OwnedSubscription } from "@getpaseo/client";
import type { Query, QueryCacheNotifyEvent, QueryClient, QueryKey } from "@tanstack/react-query";
import type { MutableDaemonConfig, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { agentCommandsQueryRoot } from "@/hooks/agent-commands-query";
import { shareCheckoutDiff } from "@/git/diff-sharing";
import { orderCheckoutDiffFiles } from "@/git/diff-order";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { daemonPairingOfferQueryKey } from "@/data/daemon-pairing";
import { type ProviderSnapshotCache } from "@/data/provider-snapshot-cache";
import {
  normalizeProvidersSnapshotCwd,
  fetchProvidersSnapshot,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
} from "@/data/providers-snapshot";

type ProvidersSnapshotUpdateMessage = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>;
type SubscribeCheckoutDiffResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "subscribe_checkout_diff_response" }
>;
type StatusMessage = Extract<SessionOutboundMessage, { type: "status" }>;
type CheckoutDiffResponsePayload = SubscribeCheckoutDiffResponseMessage["payload"];
type CheckoutDiffCachePayload = Omit<CheckoutDiffResponsePayload, "subscriptionId">;

interface CheckoutDiffCompare {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
}

interface CheckoutDiffRoute {
  domain: "checkoutDiff";
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}

interface CheckoutDiffRegistration extends CheckoutDiffRoute {
  subscription: OwnedSubscription<CheckoutDiffResponsePayload>;
}

type ServerDataRoute = CheckoutDiffRoute;

export interface ServerDataQueryMeta extends Record<string, unknown> {
  serverData: ServerDataRoute;
}

export type ProvidersSnapshotUpdate = ProvidersSnapshotUpdateMessage;

interface ServerDataPushClient {
  getProvidersSnapshot: import("@getpaseo/client/internal/daemon-client").DaemonClient["getProvidersSnapshot"];
  observeEvents: import("@getpaseo/client/internal/daemon-client").DaemonClient["observeEvents"];
  observeCheckoutDiff: import("@getpaseo/client/internal/daemon-client").DaemonClient["observeCheckoutDiff"];
}

interface PushRouterInput {
  client: ServerDataPushClient;
  queryClient: QueryClient;
  serverId: string;
}

interface ActiveServerDataSubscriptions {
  checkoutDiff: Map<string, CheckoutDiffRoute>;
}

interface ReconnectRepairPolicy {
  domain: string;
  invalidate(input: { queryClient: QueryClient; serverId: string }): void;
}

const RECONNECT_REPAIR_POLICIES: ReconnectRepairPolicy[] = [
  {
    domain: "providersSnapshot",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });
    },
  },
  {
    domain: "daemonConfig",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
    },
  },
  {
    domain: "daemonPairingOffer",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: daemonPairingOfferQueryKey(serverId) });
    },
  },
  {
    domain: "checkoutDiff",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "checkoutDiff", serverId),
      });
    },
  },
];

export function checkoutDiffPushRoute(input: {
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "checkoutDiff",
      enabled: input.enabled,
      serverId: input.serverId,
      subscriptionId: input.subscriptionId,
      cwd: input.cwd,
      compare: input.compare,
    },
  };
}

export function invalidateServerDataQueriesAfterReconnect(input: {
  queryClient: QueryClient;
  serverId: string;
}): void {
  for (const policy of RECONNECT_REPAIR_POLICIES) {
    policy.invalidate(input);
  }
}

export async function applyProvidersSnapshotUpdate(input: {
  serverId: string;
  queryClient: QueryClient;
  message: ProvidersSnapshotUpdate;
  client: Pick<ServerDataPushClient, "getProvidersSnapshot">;
  cache?: ProviderSnapshotCache;
}): Promise<void> {
  const snapshot = { ...input.message.payload, requestId: "providers_snapshot_update" };
  const cwd = normalizeProvidersSnapshotCwd(snapshot.cwd);
  const queryKey = providersSnapshotQueryKey(input.serverId, cwd);
  const previous = input.queryClient.getQueryData<{ snapshotHash?: string }>(queryKey);
  let announcement: typeof snapshot | undefined = snapshot;
  void input.queryClient.cancelQueries({ queryKey, exact: true });
  await input.queryClient.fetchQuery({
    queryKey,
    staleTime: 0,
    structuralSharing: false,
    retry: false,
    queryFn: ({ signal }) => {
      const incoming = announcement;
      announcement = undefined;
      return fetchProvidersSnapshot({
        ...input,
        cwd,
        snapshot: incoming,
        signal,
      });
    },
  });
  if (!snapshot.snapshotHash || previous?.snapshotHash !== snapshot.snapshotHash) {
    void input.queryClient.invalidateQueries({
      queryKey: agentCommandsQueryRoot(input.serverId),
      exact: false,
    });
  }
}

export function mountServerDataPushRouter(input: PushRouterInput): () => void {
  const activeCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRegistration>();
  let disposed = false;

  function reconcileSubscriptions(
    fallbackActive: ActiveServerDataSubscriptions = {
      checkoutDiff: activeCheckoutDiffSubscriptions,
    },
  ): void {
    if (disposed) {
      return;
    }

    const desiredCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRoute>();
    for (const query of input.queryClient.getQueryCache().getAll()) {
      const route = getActiveServerDataRoute(query, input.serverId, {
        checkoutDiff: fallbackActive.checkoutDiff,
      });
      if (route) desiredCheckoutDiffSubscriptions.set(route.subscriptionId, route);
    }

    reconcileCheckoutDiffSubscriptions({
      active: activeCheckoutDiffSubscriptions,
      client: input.client,
      desired: desiredCheckoutDiffSubscriptions,
      serverId: input.serverId,
      queryClient: input.queryClient,
    });
  }

  const unsubscribeQueryCache = input.queryClient.getQueryCache().subscribe((event) => {
    if (
      !shouldReconcileSubscriptionsForCacheEvent(event, input.serverId, {
        checkoutDiff: activeCheckoutDiffSubscriptions,
      })
    ) {
      return;
    }
    reconcileSubscriptions();
  });
  const events = input.client.observeEvents([
    "providers_snapshot_update",
    "status.daemon_config_changed",
  ]);
  events.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "providers_snapshot_update") {
        void applyProvidersSnapshotUpdate({
          client: input.client,
          queryClient: input.queryClient,
          serverId: input.serverId,
          message,
        }).catch(() => {
          /* Query state owns fetch failures; reconnect/refetch repairs them. */
        });
      }
      if (message.type === "status")
        applyDaemonConfigStatus({
          queryClient: input.queryClient,
          serverId: input.serverId,
          message,
        });
    },
  });

  reconcileSubscriptions();

  return () => {
    disposed = true;
    unsubscribeQueryCache();
    void events.release().catch(console.error);
    for (const current of activeCheckoutDiffSubscriptions.values()) {
      void current.subscription.release().catch(console.error);
    }
    activeCheckoutDiffSubscriptions.clear();
  };
}

function reconcileCheckoutDiffSubscriptions(input: {
  active: Map<string, CheckoutDiffRegistration>;
  client: ServerDataPushClient;
  desired: Map<string, CheckoutDiffRoute>;
  serverId: string;
  queryClient: QueryClient;
}): void {
  for (const [key, current] of input.active) {
    const desired = input.desired.get(key);
    if (desired && areCheckoutDiffRoutesEqual(current, desired)) continue;
    input.active.delete(key);
    void current.subscription.release().catch(console.error);
  }
  for (const [key, desired] of input.desired) {
    if (input.active.has(key)) continue;
    const subscription = input.client.observeCheckoutDiff(desired.cwd, desired.compare);
    const registration = { ...desired, subscription };
    input.active.set(key, registration);
    const apply = (
      payload: Omit<CheckoutDiffResponsePayload, "requestId"> & { requestId?: string },
    ) => {
      if (input.active.get(key) !== registration) return;
      const { subscriptionId, ...snapshot } = payload;
      setCheckoutDiffPayload({
        activeCheckoutDiffSubscriptions: input.active,
        queryClient: input.queryClient,
        serverId: input.serverId,
        subscriptionId: key,
        payload: {
          ...snapshot,
          files: orderCheckoutDiffFiles(payload.files),
          requestId: payload.requestId ?? `subscription:${subscriptionId}`,
        },
      });
    };
    subscription.subscribe({
      snapshot: apply,
      update: (message) => {
        if (message.type === "checkout_diff_update") apply(message.payload);
      },
      error: (error) => {
        if (input.active.get(key) === registration) input.active.delete(key);
        console.error("[server-data] observeCheckoutDiff failed", {
          serverId: input.serverId,
          cwd: desired.cwd,
          error,
        });
      },
    });
  }
}

function applyDaemonConfigStatus(input: {
  queryClient: QueryClient;
  serverId: string;
  message: StatusMessage;
}): void {
  const payload = input.message.payload;
  if (!isDaemonConfigChangedPayload(payload)) {
    return;
  }
  input.queryClient.setQueryData<MutableDaemonConfig>(
    daemonConfigQueryKey(input.serverId),
    payload.config,
  );
  void input.queryClient.invalidateQueries({
    queryKey: daemonPairingOfferQueryKey(input.serverId),
  });
}

function setCheckoutDiffPayload(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  subscriptionId: string;
  payload: CheckoutDiffCachePayload;
}): void {
  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route =
      getServerDataRoute(query) ??
      getActiveCheckoutDiffRouteForQueryKey({
        active: input.activeCheckoutDiffSubscriptions,
        queryKey: query.queryKey,
        serverId: input.serverId,
      });
    if (
      !route ||
      route.domain !== "checkoutDiff" ||
      route.serverId !== input.serverId ||
      route.subscriptionId !== input.subscriptionId
    ) {
      continue;
    }
    query.setOptions({ ...query.options, structuralSharing: shareCheckoutDiff });
    input.queryClient.setQueryData<CheckoutDiffCachePayload>(query.queryKey, input.payload);
  }
}

function getActiveServerDataRoute(
  query: Query,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): ServerDataRoute | null {
  if (query.getObserversCount() === 0) {
    return null;
  }
  const route = getServerDataRoute(query);
  if (route) {
    return route.enabled && route.serverId === serverId ? route : null;
  }
  return getActiveRouteForQueryKey({
    active,
    queryKey: query.queryKey,
    serverId,
  });
}

function getActiveRouteForQueryKey(input: {
  active: ActiveServerDataSubscriptions;
  queryKey: QueryKey;
  serverId: string;
}): ServerDataRoute | null {
  return getActiveCheckoutDiffRouteForQueryKey({
    active: input.active.checkoutDiff,
    queryKey: input.queryKey,
    serverId: input.serverId,
  });
}

function getActiveCheckoutDiffRouteForQueryKey(input: {
  active: Map<string, CheckoutDiffRoute>;
  queryKey: QueryKey;
  serverId: string;
}): CheckoutDiffRoute | null {
  if (!isQueryForServer(input.queryKey, "checkoutDiff", input.serverId)) {
    return null;
  }
  for (const route of input.active.values()) {
    if (isCheckoutDiffQueryKeyForRoute(input.queryKey, route)) {
      return route;
    }
  }
  return null;
}

function shouldReconcileSubscriptionsForCacheEvent(
  event: QueryCacheNotifyEvent,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): boolean {
  if (!canEventChangeDesiredSubscriptions(event.type)) {
    return false;
  }
  const route = getServerDataRoute(event.query);
  if (route?.serverId === serverId) {
    return true;
  }
  return (
    getActiveRouteForQueryKey({
      active,
      queryKey: event.query.queryKey,
      serverId,
    }) !== null
  );
}

function canEventChangeDesiredSubscriptions(type: QueryCacheNotifyEvent["type"]): boolean {
  return (
    type === "added" ||
    type === "removed" ||
    type === "observerAdded" ||
    type === "observerRemoved" ||
    type === "observerOptionsUpdated"
  );
}

function getServerDataRoute(query: Query): ServerDataRoute | null {
  const meta = query.meta;
  if (!isRecord(meta) || !isRecord(meta.serverData)) {
    return null;
  }
  return readServerDataRoute(meta.serverData);
}

function readServerDataRoute(value: Record<string, unknown>): ServerDataRoute | null {
  const domain = value.domain;
  const enabled = value.enabled;
  const serverId = value.serverId;
  const cwd = value.cwd;
  if (typeof enabled !== "boolean" || typeof serverId !== "string" || typeof cwd !== "string") {
    return null;
  }

  if (domain === "checkoutDiff") {
    const subscriptionId = value.subscriptionId;
    const compare = readCheckoutDiffCompare(value.compare);
    if (typeof subscriptionId !== "string" || !compare) {
      return null;
    }
    return {
      domain,
      enabled,
      serverId,
      subscriptionId,
      cwd,
      compare,
    };
  }

  return null;
}

function readCheckoutDiffCompare(value: unknown): CheckoutDiffCompare | null {
  if (!isRecord(value)) {
    return null;
  }
  const mode = value.mode;
  const baseRef = value.baseRef;
  const ignoreWhitespace = value.ignoreWhitespace;
  if (mode !== "uncommitted" && mode !== "base") {
    return null;
  }
  if (baseRef !== undefined && typeof baseRef !== "string") {
    return null;
  }
  if (ignoreWhitespace !== undefined && typeof ignoreWhitespace !== "boolean") {
    return null;
  }
  return {
    mode,
    ...(baseRef ? { baseRef } : {}),
    ...(ignoreWhitespace !== undefined ? { ignoreWhitespace } : {}),
  };
}

function areCheckoutDiffRoutesEqual(
  left: CheckoutDiffRoute | undefined,
  right: CheckoutDiffRoute,
): boolean {
  return (
    left?.serverId === right.serverId &&
    left.subscriptionId === right.subscriptionId &&
    left.cwd === right.cwd &&
    left.compare.mode === right.compare.mode &&
    left.compare.baseRef === right.compare.baseRef &&
    left.compare.ignoreWhitespace === right.compare.ignoreWhitespace
  );
}

function isCheckoutDiffQueryKeyForRoute(queryKey: QueryKey, route: CheckoutDiffRoute): boolean {
  return (
    queryKey[0] === "checkoutDiff" &&
    queryKey[1] === route.serverId &&
    queryKey[2] === route.cwd &&
    queryKey[3] === route.compare.mode &&
    queryKey[4] === (route.compare.baseRef ?? "") &&
    queryKey[5] === (route.compare.ignoreWhitespace === true)
  );
}

function isQueryForServer(queryKey: QueryKey, kind: string, serverId: string): boolean {
  return queryKey.length >= 2 && queryKey[0] === kind && queryKey[1] === serverId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDaemonConfigChangedPayload(
  payload: StatusMessage["payload"],
): payload is { status: "daemon_config_changed"; config: MutableDaemonConfig } {
  return payload.status === "daemon_config_changed" && isRecord(payload.config);
}
