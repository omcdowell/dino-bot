/**
 * Phone home (layout A, 2026-10-08): the Grok-style bot list that replaces the main menu on
 * phones. Registered with `mobileHome: true`; the app draws the top bar (three-dots menu) above it.
 *
 * Row: icon · name + last activity time · one-line preview · status at the end of the preview line
 * (same rules as the sidebar dot) with the time running while a turn is going.
 */
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as pluginReactNative from "@getpaseo/plugin/client/react-native";
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Easing, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { BotPreview } from "../shared/home-rpc";
import { BotAvatar } from "./bot-avatar";
import { useAvatarOutboxSender } from "./avatar-outbox-data";
import { useRoomsList } from "./group-data";
import { GroupHomeRow, GroupPinnedTile } from "./group-rows";
import type { RoomSummary } from "./group-types";
import {
  HOLD_DELAY_MS,
  HoldOverlay,
  LANDING_FADE_MS,
  LANDING_HOLD_MS,
  PINNED_PRESSED_OPACITY,
  measure,
  type HeldItem,
  type OnHold,
  type Variant,
} from "./hold-overlay";
import {
  effectiveHomeState,
  homeLayout,
  isDarkSurface,
  pinCircle,
  pinnedAvatarSize,
  pinnedColumns,
  type PinnedItem,
  type Rect,
} from "./manage-format";
import { hostExtras, useHomeActions, useHomeState, useManageRequests, type ManageRequest } from "./manage-data";
import { ArchivedSheet, BotSheet, GroupSheet } from "./manage-sheets";
import { botKey, groupKey, parseKey } from "../shared/manage";
import { botsOpenRpc, type Bot } from "../shared/rpc";
import {
  BOTS_QUERY_KEY,
  useBotRowStatus,
  useBotsData,
  usePreviews,
  useRefreshPreviewsOnChange,
  type Previews,
  type QuietAnswer,
} from "./bot-data";
import {
  activityAt,
  formatElapsed,
  recencyOf,
  rememberStatus,
  rowTime,
  runningSince,
  spokenElapsed,
  type LastKnownStatus,
} from "./home-format";
import { rowWorkerCount, showWorkerCount, statusText, STATUS_LABEL, type BotStatus } from "./status";
import { accentText } from "./accent";
import { openChatPatiently, startingLabel } from "./bot-open";

export { BOTS_PREVIEWS_KEY } from "./bot-data";
/** Statuses last seen live, shown dimmed while the host has not answered (device cache). */
export const BOTS_LAST_STATUS_KEY = ["bots", "last-status"] as const;

type LastKnown = Readonly<Record<string, LastKnownStatus>>;
type Open = (bot: Bot) => void;
const EXTRAS = hostExtras(pluginReactNative, pluginUi);

/** Re-renders every second while `active`, for the time-running readout. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Ring / dot / count / time running, at the end of the preview line. `workers` is the number
 * beside the dot: outstanding workers, or stalled ones when stalled (rowWorkerCount).
 */
function StatusTrail({
  status,
  workers,
  runningMs,
  theme,
  stale = false,
}: {
  status: BotStatus;
  workers: number;
  runningMs: number | null;
  theme: PluginTheme;
  /** Last known (from the device cache), not live: drawn faint. */
  stale?: boolean;
}) {
  if (status === "none" || status === "read") return null;
  const c = theme.colors;
  const color = {
    working: c.foregroundMuted,
    waiting: c.foregroundMuted,
    unread: accentText(c),
    "needs-you": c.statusWarning,
    error: c.statusDanger,
    stalled: c.statusDanger,
  }[status];
  const hollow = status === "working" || status === "waiting";
  const count = status === "waiting" || showWorkerCount(status, workers);
  const label = [
    statusText(status, workers),
    runningMs !== null ? spokenElapsed(runningMs) : "",
    stale ? "last known" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View
      accessible
      accessibilityLabel={label}
      testID={stale ? "bots-home-status-stale" : "bots-home-status"}
      style={{ flexDirection: "row", alignItems: "center", marginLeft: 10, gap: 6, opacity: stale ? 0.45 : 1 }}
    >
      {runningMs !== null ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
          {formatElapsed(runningMs)}
        </Text>
      ) : null}
      {count && workers > 0 ? (
        <Text
          style={{ color: status === "stalled" ? c.statusDanger : c.foregroundMuted, fontSize: 13, fontVariant: ["tabular-nums"] }}
        >
          {workers}
        </Text>
      ) : null}
      <View
        style={{
          width: hollow ? 12 : 10,
          height: hollow ? 12 : 10,
          borderRadius: 6,
          backgroundColor: hollow ? "transparent" : color,
          borderWidth: hollow ? 1.5 : 0,
          borderStyle: status === "waiting" ? "dashed" : "solid",
          borderColor: color,
        }}
      />
    </View>
  );
}

/** Live status of one bot plus the running time; asks for fresh previews when the status changes. */
function useRowState(
  bot: Bot,
  workers: number,
  stalled: number,
  quiet: QuietAnswer,
  previews: Previews,
  lastKnown: LastKnown,
  hostAway: boolean,
) {
  const live = useBotRowStatus(bot.agentId, workers, quiet, stalled);
  const known = lastKnown[bot.id]?.status as BotStatus | undefined;
  const fromCache = !live.live && !!known;
  // While the host has not answered, every status is last known (drawn faint).
  const stale = fromCache || hostAway;
  const status: BotStatus = fromCache ? known! : live.status;
  const lastActivityAt = live.lastActivityAt;
  const workingSeenAt = useRef(0);
  const previous = useRef<BotStatus | null>(null);
  if (status === "working" && previous.current !== "working") workingSeenAt.current = Date.now();
  previous.current = status;
  useRefreshPreviewsOnChange(status);
  const row = previews.rows.get(bot.id);
  const since =
    status === "working" ? runningSince(row?.turnStartedAt, previews.fetchedAt, workingSeenAt.current) : null;
  return {
    status,
    stale,
    // Only statuses seen with the host answering are remembered as last known.
    live: live.live && !hostAway,
    lastActivityAt,
    activityAt: activityAt(row),
    preview: row?.preview ?? null,
    since: stale ? null : since,
    /** Number beside the dot. */
    count: rowWorkerCount(status, workers, stalled),
  };
}

function PreviewLine({ preview, status, theme }: { preview: BotPreview | null; status: BotStatus; theme: PluginTheme }) {
  const c = theme.colors;
  const emphasised = status === "unread" || status === "needs-you" || status === "stalled";
  const fallback = status === "none" ? "No chat yet" : STATUS_LABEL[status] || "";
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 }}>
      {preview?.kind === "dm" ? (
        <View style={{ marginRight: 6 }}>
          <Icon name="Send" size={14} color={c.foregroundMuted} />
        </View>
      ) : null}
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: 15, color: emphasised ? c.foreground : c.foregroundMuted }}
      >
        {preview?.text ?? fallback}
      </Text>
    </View>
  );
}

function BotHomeRow({
  bot,
  theme,
  workers,
  stalled,
  quiet,
  previews,
  now,
  busy,
  onOpen,
  onActivity,
  lastKnown,
  hostAway,
  onHold,
  variant = "list",
}: {
  bot: Bot;
  theme: PluginTheme;
  workers: number;
  stalled: number;
  quiet: QuietAnswer;
  previews: Previews;
  now: number;
  busy: boolean;
  onOpen: Open;
  lastKnown: LastKnown;
  hostAway: boolean;
  onActivity: (botId: string, status: BotStatus, live: boolean, at: string | null) => void;
  onHold?: OnHold;
  variant?: Variant;
}) {
  const ref = useRef<View>(null);
  const held = variant === "held";
  const { status, stale, live, lastActivityAt, activityAt: at, preview, since, count } = useRowState(
    bot,
    workers,
    stalled,
    quiet,
    previews,
    lastKnown,
    hostAway,
  );
  useEffect(
    () => onActivity(bot.id, status, live, lastActivityAt),
    [bot.id, lastActivityAt, live, onActivity, status],
  );
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}${preview ? `. ${preview.text}` : ""}`}
      testID={held ? `bots-held-row-${bot.id}` : `bots-home-row-${bot.id}`}
      ref={ref}
      onPress={() => onOpen(bot)}
      onLongPress={onHold ? () => measure(ref.current, onHold) : undefined}
      delayLongPress={HOLD_DELAY_MS}
      disabled={busy || held}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: held ? 14 : 16,
        paddingVertical: 12,
        minHeight: held ? undefined : 88,
        flex: held ? 1 : undefined,
        opacity: busy ? 0.5 : 1,
        backgroundColor: pressed && !held ? c.surface1 : "transparent",
      })}
    >
      <BotAvatar bot={bot} size={56} theme={theme} />
      <View style={{ flex: 1, marginLeft: 14, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 17, fontWeight: "700", color: c.foreground }}>
            {bot.name}
          </Text>
          <Text style={{ fontSize: 14, marginLeft: 8, color: status === "unread" ? accentText(c) : c.foregroundMuted }}>
            {rowTime(at ?? lastActivityAt, new Date(now))}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
          <PreviewLine preview={preview} status={status} theme={theme} />
          {busy ? (
            <ActivityIndicator size="small" color={c.foregroundMuted} style={{ marginLeft: 10 }} />
          ) : (
            <StatusTrail
              status={status}
              workers={count}
              runningMs={since !== null ? now - since : null}
              theme={theme}
              stale={stale}
            />
          )}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * A pinned bot (r4/r5): avatar, name cut with "…" to its column, status pill. `held`: inside
 * the lifted 176 pt square, full name.
 */
function PinnedBotTile({
  bot,
  theme,
  workers,
  stalled,
  quiet,
  previews,
  now,
  busy,
  onOpen,
  onActivity,
  lastKnown,
  hostAway,
  size,
  width,
  labelWidth,
  onHold,
  variant = "list",
}: {
  bot: Bot;
  theme: PluginTheme;
  workers: number;
  stalled: number;
  quiet: QuietAnswer;
  previews: Previews;
  now: number;
  busy: boolean;
  onOpen: Open;
  lastKnown: LastKnown;
  hostAway: boolean;
  onActivity: (botId: string, status: BotStatus, live: boolean, at: string | null) => void;
  size: number;
  width: number;
  /** List variant: the name's own width, may be wider than the tile (centred over it). */
  labelWidth?: number;
  onHold?: OnHold;
  variant?: Variant;
}) {
  const ref = useRef<View>(null);
  const held = variant === "held";
  const { status, stale, live, lastActivityAt, since, count } = useRowState(
    bot,
    workers,
    stalled,
    quiet,
    previews,
    lastKnown,
    hostAway,
  );
  useEffect(
    () => onActivity(bot.id, status, live, lastActivityAt),
    [bot.id, lastActivityAt, live, onActivity, status],
  );
  const c = theme.colors;
  const label = STATUS_LABEL[status];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}${label ? `, ${statusText(status, count)}` : ""}`}
      testID={held ? `bots-held-pinned-${bot.id}` : `bots-home-pinned-${bot.id}`}
      ref={ref}
      onPress={() => onOpen(bot)}
      onLongPress={onHold ? () => measure(ref.current, onHold) : undefined}
      delayLongPress={HOLD_DELAY_MS}
      disabled={busy || held}
      style={({ pressed }) => ({
        width,
        alignItems: "center",
        paddingTop: held ? 0 : 8,
        paddingBottom: held ? 0 : 20,
        opacity: (pressed && !held) || busy ? 0.6 : 1,
      })}
    >
      <BotAvatar bot={bot} size={size} theme={theme} />
      <Text
        numberOfLines={held ? 2 : 1}
        ellipsizeMode="tail"
        style={{
          marginTop: held ? 10 : 12,
          fontSize: 17,
          color: c.foregroundMuted,
          textAlign: "center",
          ...(!held && labelWidth !== undefined ? { width: labelWidth } : { maxWidth: width - 4 }),
        }}
      >
        {bot.name}
      </Text>
      {label ? (
        <View
          style={{
            marginTop: 8,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 12,
            paddingVertical: 4,
            borderRadius: 999,
            backgroundColor: c.surface2,
            maxWidth: width,
          }}
        >
          <Text numberOfLines={1} style={{ fontSize: 14, color: c.foregroundMuted, opacity: stale ? 0.6 : 1, flexShrink: 1 }}>
            {label}
          </Text>
          <StatusTrail
            status={status}
            workers={count}
            runningMs={since !== null ? now - since : null}
            theme={theme}
            stale={stale}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Old apps without the "⋯" menu entries: the same three actions as small links under the list. */
function ManageLinks({ theme, onRequest }: { theme: PluginTheme; onRequest(request: ManageRequest): void }) {
  const c = theme.colors;
  const link = (request: ManageRequest, text: string) => (
    <Pressable key={request} accessibilityRole="button" testID={`bots-home-manage-${request}`} onPress={() => onRequest(request)} hitSlop={8}>
      <Text style={{ fontSize: 14, color: c.foregroundMuted }}>{text}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: 22, paddingTop: 18 }}>
      {link("new-bot", "New bot")}
      {link("new-group", "New group chat")}
      {link("archived", "Archived")}
    </View>
  );
}

export function HomeScreen({ theme, navigation, host }: PluginScreenProps) {
  const { bots, isLoading, error, lastKnown: listIsLastKnown, workerCounts, stalledCounts, quiet, refetch } = useBotsData();
  const { previews, refetch: refetchPreviews } = usePreviews();
  // Avatar saves made in the designer (AV3): sent from here, retried at once when the host answers again.
  useAvatarOutboxSender(!listIsLastKnown);
  const openChat = useRpc(botsOpenRpc);
  const queryClient = useQueryClient();
  const lastKnown: LastKnown =
    useQuery({
      queryKey: BOTS_LAST_STATUS_KEY,
      queryFn: () => queryClient.getQueryData<LastKnown>(BOTS_LAST_STATUS_KEY) ?? {},
      staleTime: Infinity,
      meta: { persist: true },
    }).data ?? {};
  const [busyBot, setBusyBot] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // A first open that is slow (the host is creating the bot's chat): "Starting <bot>…".
  const [starting, setStarting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Rows report their status: the clock ticks only while one works, and live statuses are kept
  // on the device (last known) for the next cold start.
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  // The agent's own activity time, only to order bots the server has no message time for.
  const [agentAt, setAgentAt] = useState<ReadonlyMap<string, string>>(new Map());
  const onActivity = useRef((botId: string, status: BotStatus, live: boolean, at: string | null) => {
    if (at) setAgentAt((current) => (current.get(botId) === at ? current : new Map(current).set(botId, at)));
    setWorking((current) => {
      const isWorking = live && status === "working";
      if (current.has(botId) === isWorking) return current;
      const next = new Set(current);
      if (isWorking) next.add(botId);
      else next.delete(botId);
      return next;
    });
    if (!live) return;
    queryClient.setQueryData<LastKnown>(BOTS_LAST_STATUS_KEY, (held = {}) =>
      rememberStatus(held, botId, status, Date.now()),
    );
  }).current;
  const anyWorking = working.size > 0;
  const now = useNow(anyWorking);
  // Group chats sit among the bots' chats and rise on recency (13 Oct).
  const { groups, refetch: refetchGroups } = useRoomsList();

  const open: Open = (bot) => {
    if (!navigation) {
      setOpenError("This Paseo app is too old to open chats from plugins. Update the app.");
      return;
    }
    setOpenError(null);
    if (bot.agentId) {
      navigation.openAgent({ agentId: bot.agentId });
      return;
    }
    setBusyBot(bot.id);
    openChatPatiently(() => openChat({ botId: bot.id }), { onStarting: () => setStarting(startingLabel(bot.name)) })
      .then((result) => {
        if (result.created) void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY });
        navigation.openAgent({ agentId: result.agentId });
      })
      .catch((cause: unknown) => setOpenError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setBusyBot(null);
        setStarting(null);
      });
  };

  const c = theme.colors;
  const dark = isDarkSurface(c.surface0);
  const { width } = useWindowDimensions();
  // Pinned row (up to three bots or groups), then the rest mingled by recency; archived left out.
  const { state: savedState } = useHomeState();
  const homeState = effectiveHomeState(savedState, bots);
  const actions = useHomeActions();
  const toast = pluginReactNative.useToast();
  const recency = recencyOf(previews.rows, agentAt);
  const layout = homeLayout(bots, groups, homeState, recency);
  const columns = pinnedColumns(layout.pinned.length, width);
  const avatarSize = pinnedAvatarSize(layout.pinned.length);
  const rowProps = { theme, quiet, previews, now, onOpen: open, onActivity, lastKnown, hostAway: listIsLastKnown };

  // Press and hold.
  const [held, setHeld] = useState<HeldItem | null>(null);
  // The held item's original is hidden while the overlay draws it, until it has landed back.
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  // Landing flash (14 Oct: "the same colour change on a tap ... when the bot card hits the
  // page again"): the tap colour (rows: surface1 behind, pinned: 60% opacity), held briefly, then
  // faded out. It starts on the overlay's copy just before landing and carries on over the original.
  const flash = useRef(new Animated.Value(0)).current;
  const pinnedFlash = useRef(
    flash.interpolate({ inputRange: [0, 1], outputRange: [1, PINNED_PRESSED_OPACITY] }),
  ).current;
  const [landingKey, setLandingKey] = useState<string | null>(null);
  const land = (key: string) => {
    flash.stopAnimation();
    flash.setValue(1);
    setLandingKey(key);
    Animated.sequence([
      Animated.delay(LANDING_HOLD_MS),
      Animated.timing(flash, { toValue: 0, duration: LANDING_FADE_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setLandingKey((current) => (current === key ? null : current));
    });
  };
  const hideable = (key: string, node: ReactNode, from: "pinned" | "row") => {
    const landing = landingKey === key;
    if (from === "pinned") {
      return (
        <Animated.View key={key} style={{ opacity: hiddenKey === key ? 0 : landing ? pinnedFlash : 1 }}>
          {node}
        </Animated.View>
      );
    }
    return (
      <View key={key} style={{ opacity: hiddenKey === key ? 0 : 1 }}>
        {landing ? (
          <Animated.View
            pointerEvents="none"
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.surface1, opacity: flash }}
          />
        ) : null}
        {node}
      </View>
    );
  };
  const hold = (item: Omit<HeldItem, "rect">) => (rect: Rect) => {
    EXTRAS.haptic("medium");
    // A new hold right after a landing: end that flash first.
    flash.stopAnimation();
    flash.setValue(0);
    setLandingKey(null);
    setHeld({ ...item, rect });
  };
  const pinnedContent = (entry: PinnedItem<Bot, RoomSummary>, variant: "list" | "held", onHold?: OnHold): ReactNode =>
    entry.kind === "bot" ? (
      <PinnedBotTile
        key={entry.key}
        bot={entry.bot}
        workers={workerCounts.get(entry.bot.id) ?? 0}
        stalled={stalledCounts.get(entry.bot.id) ?? 0}
        busy={busyBot === entry.bot.id}
        size={variant === "held" ? 72 : avatarSize}
        width={variant === "held" ? 156 : columns.columnWidth}
        labelWidth={columns.labelWidth}
        variant={variant}
        onHold={onHold}
        {...rowProps}
      />
    ) : (
      <GroupPinnedTile
        key={entry.key}
        group={entry.group}
        bots={bots}
        theme={theme}
        size={variant === "held" ? 72 : avatarSize}
        width={variant === "held" ? 156 : columns.columnWidth}
        labelWidth={columns.labelWidth}
        variant={variant}
        onHold={onHold}
        onError={setOpenError}
      />
    );
  const rowContent = (row: (typeof layout.rows)[number], variant: "list" | "held", onHold?: OnHold): ReactNode =>
    row.kind === "group" ? (
      <GroupHomeRow
        key={row.key}
        group={row.group}
        bots={bots}
        now={now}
        theme={theme}
        onError={setOpenError}
        variant={variant}
        onHold={onHold}
      />
    ) : (
      <BotHomeRow
        key={row.key}
        bot={row.bot}
        workers={workerCounts.get(row.bot.id) ?? 0}
        stalled={stalledCounts.get(row.bot.id) ?? 0}
        busy={busyBot === row.bot.id}
        variant={variant}
        onHold={onHold}
        {...rowProps}
      />
    );
  const nameOf = (entry: PinnedItem<Bot, RoomSummary>) => (entry.kind === "bot" ? entry.bot.name : entry.group.name);
  const keyOfRow = (row: (typeof layout.rows)[number]) => (row.kind === "bot" ? botKey(row.bot.id) : groupKey(row.group.id));

  // Sheets: from the hold circles and the "⋯" menu.
  const [sheet, setSheet] = useState<
    | { kind: "bot"; bot: Bot | null }
    | { kind: "group"; group: RoomSummary | null }
    | { kind: "archived" }
    | null
  >(null);
  const onRequest = useCallback((request: ManageRequest) => {
    // The app's menu sheet is still closing: open ours just after it.
    setTimeout(
      () => setSheet(request === "new-bot" ? { kind: "bot", bot: null } : request === "new-group" ? { kind: "group", group: null } : { kind: "archived" }),
      EXTRAS.homeMenu ? 450 : 0,
    );
  }, []);
  useManageRequests(onRequest);
  const failed = (cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause));
  const itemFor = (key: string) => {
    const parsed = parseKey(key);
    if (!parsed) return null;
    return parsed.kind === "bot"
      ? { kind: "bot" as const, bot: bots.find((b) => b.id === parsed.id) ?? null }
      : { kind: "group" as const, group: groups.find((g) => g.id === parsed.id) ?? null };
  };
  const onArchive = (item: HeldItem) =>
    void actions
      .archive(item.key, true)
      .then(() => {
        EXTRAS.haptic("success");
        toast.show(`${item.name} archived`);
      })
      .catch(failed);
  const onEdit = (item: HeldItem) => {
    const found = itemFor(item.key);
    // iOS cannot present the sheet while the hold overlay's Modal is still going away.
    setTimeout(() => {
      if (found?.kind === "bot" && found.bot) setSheet({ kind: "bot", bot: found.bot });
      if (found?.kind === "group" && found.group) setSheet({ kind: "group", group: found.group });
    }, 300);
  };
  const onPin = (item: HeldItem) =>
    void actions.pin(item.key, !homeState.pins.includes(item.key)).then(() => EXTRAS.haptic("selection")).catch(failed);
  const archivedKeys = new Set(Object.keys(homeState.archived));
  const memberChoices = bots.filter((bot) => !archivedKeys.has(botKey(bot.id)));

  return (
    <>
    <ScrollView
      testID="bots-home"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={c.foregroundMuted}
          onRefresh={() => {
            setRefreshing(true);
            void Promise.all([refetch(), refetchPreviews(), refetchGroups()]).finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {isLoading ? <ActivityIndicator style={{ marginTop: 48 }} color={c.foregroundMuted} /> : null}
      {listIsLastKnown ? (
        <Text
          testID="bots-home-last-known"
          style={{ color: c.foregroundMuted, fontSize: 13, textAlign: "center", paddingTop: 4, paddingBottom: 4 }}
        >
          Last known · waiting for the host
        </Text>
      ) : null}
      {error && !listIsLastKnown ? (
        <Text style={{ color: c.statusDanger, padding: 20 }}>
          {error instanceof Error ? error.message : String(error)}
        </Text>
      ) : null}
      {openError ? <Text style={{ color: c.statusDanger, paddingHorizontal: 20, paddingBottom: 8 }}>{openError}</Text> : null}
      {starting ? (
        <Text testID="bots-home-starting" style={{ color: c.foregroundMuted, paddingHorizontal: 20, paddingBottom: 8 }}>
          {starting}
        </Text>
      ) : null}
      {layout.pinned.length ? (
        <View testID="bots-home-pinned" style={{ flexDirection: "row", justifyContent: "space-evenly", alignItems: "flex-start" }}>
          {layout.pinned.map((entry) =>
            hideable(
              entry.key,
              pinnedContent(
                entry,
                "list",
                hold({
                  key: entry.key,
                  name: nameOf(entry),
                  from: "pinned",
                  source: pinnedContent(entry, "list"),
                  avatarSize,
                }),
              ),
              "pinned",
            ),
          )}
        </View>
      ) : null}
      {layout.rows.map((row) =>
        hideable(
          keyOfRow(row),
          rowContent(
            row,
            "list",
            hold({
              key: keyOfRow(row),
              name: row.kind === "bot" ? row.bot.name : row.group.name,
              from: "row",
              source: rowContent(row, "list"),
            }),
          ),
          "row",
        ),
      )}
      {!EXTRAS.homeMenu && bots.length ? <ManageLinks theme={theme} onRequest={onRequest} /> : null}
    </ScrollView>
    <HoldOverlay
      held={held}
      theme={theme}
      dark={dark}
      pin={held ? pinCircle(homeState, held.key) : { pinned: false, disabled: false, message: null }}
      flash={flash}
      onShown={() => setHiddenKey(held?.key ?? null)}
      onLanding={() => held && land(held.key)}
      onClose={() => {
        setHiddenKey(null);
        setHeld(null);
      }}
      onArchive={onArchive}
      onEdit={onEdit}
      onPin={onPin}
    />
    <BotSheet
      open={sheet?.kind === "bot"}
      bot={sheet?.kind === "bot" ? sheet.bot : null}
      theme={theme}
      extras={EXTRAS}
      serverId={host.id}
      botCount={bots.length}
      onClose={() => setSheet(null)}
      onSaved={() => void actions.refreshAll()}
    />
    <GroupSheet
      open={sheet?.kind === "group"}
      group={sheet?.kind === "group" ? sheet.group : null}
      bots={memberChoices}
      theme={theme}
      extras={EXTRAS}
      onClose={() => setSheet(null)}
      onSaved={() => void actions.refreshAll()}
    />
    <ArchivedSheet
      open={sheet?.kind === "archived"}
      items={layout.archived}
      bots={bots}
      theme={theme}
      onClose={() => setSheet(null)}
      onUnarchive={(key) => actions.archive(key, false).catch(failed)}
    />
    </>
  );
}
