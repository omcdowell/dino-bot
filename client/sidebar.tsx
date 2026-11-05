import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { dmsSummaryRpc } from "../shared/dm-rpc";
import { botsOpenRpc, type Bot } from "../shared/rpc";
import { openBotFromSidebar, startingLabel, type BotsSidebarItemProps } from "./bot-open";
import { BOTS_QUERY_KEY } from "./bot-data";
import { DMS_SUMMARY_KEY, SUMMARY_POLL_MS, explorerHostsPanels, showDmsRow } from "./dms-format";
import { useBotRowStatus, useBotsData, usePreviews, useRefreshPreviewsOnChange, type QuietAnswer } from "./bot-data";
import { holdOrder, recencyOf, sinceShort, spokenSince } from "./home-format";
import { effectiveHomeState, homeLayout, sidebarOrder } from "./manage-format";
import { useHomeState } from "./manage-data";
import { useRoomsList } from "./group-data";
import { GroupSidebarRow, openGroupId } from "./group-rows";
import { openGroupScreen } from "./group-nav";
import type { RoomSummary } from "./group-types";
import { rowWorkerCount, showWorkerCount, statusText, type BotStatus } from "./status";
import { accentText } from "./accent";

export { BOTS_QUERY_KEY, BOTS_WORKERS_KEY, BOTS_QUIET_KEY } from "./bot-data";

/**
 * Row indicator. working: hollow ring. waiting: dashed ring + worker count. unread: accent dot.
 * needs-you: amber dot. error: red dot. stalled: red dot + number of workers that stopped on an
 * error. read and none: nothing. `workers` is the number beside the dot (see rowWorkerCount).
 */
export function Dot({ status, workers = 0, theme }: { status: BotStatus; workers?: number; theme: PluginTheme }) {
  if (status === "none" || status === "read") return null;
  const color = {
    working: theme.colors.foregroundMuted,
    waiting: theme.colors.foregroundMuted,
    unread: accentText(theme.colors),
    "needs-you": theme.colors.statusWarning,
    error: theme.colors.statusDanger,
    stalled: theme.colors.statusDanger,
  }[status];
  const hollow = status === "working" || status === "waiting";
  const count = showWorkerCount(status, workers);
  return (
    <View
      accessibilityLabel={statusText(status, workers)}
      style={{ flexDirection: "row", alignItems: "center", marginRight: 8 }}
    >
      {count ? (
        <Text
          style={{
            color: status === "stalled" ? theme.colors.statusDanger : theme.colors.foregroundMuted,
            fontSize: 11,
            marginRight: 4,
            fontVariant: ["tabular-nums"],
          }}
        >
          {workers}
        </Text>
      ) : null}
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: hollow ? "transparent" : color,
          borderWidth: hollow ? 1.5 : 0,
          borderStyle: status === "waiting" ? "dashed" : "solid",
          borderColor: color,
        }}
      />
    </View>
  );
}

/** How often the rows' "last used" times tick over: local only, nothing is fetched. */
const LAST_USED_TICK_MS = 60_000;

/** The current time, re-read once a minute so "4m" becomes "5m" without a fetch. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LAST_USED_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The bot's last-used time at the row's right edge ("now", "4m", "2h", "Tue", "3 Oct"). */
export function LastUsed({ at, now, theme }: { at: string | null; now: number; theme: PluginTheme }) {
  const text = sinceShort(at, new Date(now));
  if (!text) return null;
  return (
    <Text
      accessibilityLabel={spokenSince(at, new Date(now))}
      numberOfLines={1}
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontVariant: ["tabular-nums"],
        flexShrink: 0,
      }}
    >
      {text}
    </Text>
  );
}

function BotRow({
  bot,
  theme,
  active,
  workers,
  stalled,
  quiet,
  lastUsed,
  now,
  onOpen,
  onAgentActivity,
}: {
  bot: Bot;
  theme: PluginTheme;
  active: boolean;
  /** Herdr workers the bot launched that are still running or blocked. */
  workers: number;
  /** Herdr workers it launched that stopped on an error without reporting. */
  stalled: number;
  /** Server's DM-only answer for this chat, and when it was fetched. */
  quiet: QuietAnswer;
  /** When the bot was last used: the same recency the sort uses (`recencyOf`). */
  lastUsed: string | null;
  /** The sidebar's minute clock, for `lastUsed`. */
  now: number;
  onOpen: (bot: Bot) => void;
  /** The agent's own activity time, for ordering bots the server has no message time for. */
  onAgentActivity: (botId: string, at: string | null) => void;
}) {
  // Reads the app's own live agent state: no extra subscription over the network.
  const { status, lastActivityAt } = useBotRowStatus(bot.agentId, workers, quiet, stalled);
  // A turn started or ended: fresh previews now, so the order follows without waiting for the poll.
  useRefreshPreviewsOnChange(status);
  useEffect(() => onAgentActivity(bot.id, lastActivityAt), [bot.id, lastActivityAt, onAgentActivity]);
  return (
    <SidebarRow
      id={`bot-${bot.id}`}
      icon={bot.icon}
      label={bot.name}
      active={active}
      onPress={() => onOpen(bot)}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
          <Dot status={status} workers={rowWorkerCount(status, workers, stalled)} theme={theme} />
          <LastUsed at={lastUsed} now={now} theme={theme} />
        </View>
      }
    />
  );
}

/**
 * Plain link to the bot's DMs: no count or badge, since the DMs are not addressed to the owner.
 * Only where the Explorer cannot host the DMs panel (iOS/Android app, narrow web): elsewhere the
 * DMs live in the Explorer sidebar of the bot's workspace.
 */
function DmsRow({
  bot,
  active,
  onOpen,
}: {
  bot: Bot;
  active: boolean;
  onOpen: (bot: Bot) => void;
}) {
  return (
    <SidebarRow
      id={`dms-${bot.id}`}
      icon="CornerDownRight"
      label="DMs"
      active={active}
      onPress={() => onOpen(bot)}
    />
  );
}

export function BotsSidebarItem({ theme, layout, currentScreen, openScreen, navigation }: BotsSidebarItemProps) {
  const dmsRows = !explorerHostsPanels(layout);
  const { bots, workerCounts, stalledCounts, quiet } = useBotsData();
  const dmsSummary = useRpc(dmsSummaryRpc);
  const openChat = useRpc(botsOpenRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: dms } = useQuery({
    queryKey: DMS_SUMMARY_KEY,
    queryFn: () => dmsSummary({}),
    staleTime: 10_000,
    refetchInterval: SUMMARY_POLL_MS,
    enabled: dmsRows,
  });
  const { previews } = usePreviews();
  // The agent's own activity time (fallback order key), as the phone home keeps it.
  const [agentAt, setAgentAt] = useState<ReadonlyMap<string, string>>(new Map());
  const onAgentActivity = useRef((botId: string, at: string | null) => {
    if (at) setAgentAt((current) => (current.get(botId) === at ? current : new Map(current).set(botId, at)));
  }).current;
  // Rows do not move while the pointer is over the list (desktop): the new order lands on leave.
  const [hovered, setHovered] = useState(false);
  const shown = useRef<string[] | null>(null);
  const now = useMinuteNow();
  const { groups } = useRoomsList();
  const { state: homeState } = useHomeState();
  if (!bots.length) return null;
  // Same order as the phone home: The Fat Controller pinned on top, then bots and group chats
  // together, newest activity first (a group's time is its last room message).
  const recency = recencyOf(previews.rows, agentAt);
  // Pinned items first (pin order), then the rest by recency; archived ones are hidden (build 31).
  const mixed = sidebarOrder(homeLayout(bots, groups, effectiveHomeState(homeState, bots), recency));
  const byKey = new Map<string, { bot: Bot } | { group: RoomSummary }>(
    mixed.map((r) => [r.key, r.kind === "bot" ? { bot: r.bot } : { group: r.group }]),
  );
  const fresh = mixed.map((r) => r.key);
  shown.current = hovered ? holdOrder(shown.current, fresh) : fresh;
  const ordered = shown.current.map((key) => byKey.get(key)!).filter(Boolean);
  const openGroup = openGroupId(currentScreen);
  const summaries = new Map((dms?.bots ?? []).map((s) => [s.botId, s]));
  const openBotId = currentScreen?.screenId === "bot" ? currentScreen.params.botId : undefined;
  const openDmsBotId = currentScreen?.screenId === "dms" ? currentScreen.params.botId : undefined;
  const openDms = (bot: Bot) => openScreen({ screenId: "dms", params: { botId: bot.id, name: bot.name } });
  const open = (bot: Bot) =>
    void openBotFromSidebar(bot, {
      navigation,
      openScreen,
      openChat: (botId) => openChat({ botId }),
      onCreated: () => void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY }),
      onStarting: (b) => toast.show(startingLabel(b.name)),
    });
  const row = (bot: Bot) => {
    const summary = summaries.get(bot.id);
    return (
      <Fragment key={bot.id}>
        <BotRow
          bot={bot}
          theme={theme}
          active={bot.id === openBotId}
          workers={workerCounts.get(bot.id) ?? 0}
          stalled={stalledCounts.get(bot.id) ?? 0}
          quiet={quiet}
          lastUsed={recency(bot)}
          now={now}
          onOpen={open}
          onAgentActivity={onAgentActivity}
        />
        {dmsRows && showDmsRow(summary) ? (
          <DmsRow bot={bot} active={bot.id === openDmsBotId} onOpen={openDms} />
        ) : null}
      </Fragment>
    );
  };
  return (
    <>
      <SidebarSeparator />
      {/* gap: 2 matches the app's sidebar header group, which spaced these rows before the wrapper. */}
      <View
        style={{ gap: 2 }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {ordered.map((entry) =>
          "bot" in entry ? (
            row(entry.bot)
          ) : (
            <GroupSidebarRow
              key={`group:${entry.group.id}`}
              group={entry.group}
              bots={bots}
              active={entry.group.id === openGroup}
              theme={theme}
              trailingTime={<LastUsed at={entry.group.lastTs} now={now} theme={theme} />}
              onOpen={() => openGroupScreen(entry.group, openScreen)}
            />
          ),
        )}
      </View>
    </>
  );
}
