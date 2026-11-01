import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { MoreVertical, Pause, Play } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { useTimeAgo } from "@/hooks/use-time-ago";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  fetchSystemdTimers,
  setSystemdTimerPaused,
  timerBadge,
  timerMeta,
  type SystemdTimer,
  type TimersHost,
} from "@/schedules/systemd-timers";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { formatNextRun } from "@/utils/schedule-format";

const REFRESH_MS = 30_000;
const TIMERS_QUERY_KEY = "systemd-timers";
const ICON_SIZE = 14;
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedKebab = withUnistyles(MoreVertical);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The online hosts' systemd user timers (bots plugin), filtered to the selected host. */
export function useSystemdTimers(selectedHost: string): SystemdTimer[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const online = serverIds.filter((id) => statuses.get(id) === "online");
  const query = useFetchQuery({
    queryKey: [TIMERS_QUERY_KEY, online.join("|")],
    dataShape: "list",
    staleTimeMs: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    retry: false,
    enabled: online.length > 0,
    queryFn: () => {
      const runtime = getHostRuntimeStore();
      const inputs = hosts.flatMap((host): TimersHost[] => {
        const client = online.includes(host.serverId) ? runtime.getClient(host.serverId) : null;
        return client ? [{ serverId: host.serverId, serverName: host.label, client }] : [];
      });
      return fetchSystemdTimers(inputs);
    },
  });
  return useMemo(
    () =>
      (query.data ?? []).filter(
        (timer) => selectedHost === ALL_HOSTS_OPTION_ID || timer.serverId === selectedHost,
      ),
    [query.data, selectedHost],
  );
}

/** Read-only card of systemd timers, under the Paseo schedules. */
export function SystemdTimersSection(props: {
  timers: SystemdTimer[];
  showHost: boolean;
}): ReactElement | null {
  const { timers, showHost } = props;
  if (timers.length === 0) return null;
  return (
    <View style={styles.section} testID="systemd-timers">
      <View style={settingsStyles.sectionHeader}>
        <Text style={settingsStyles.sectionHeaderTitle}>Systemd timers · no model</Text>
      </View>
      <View style={settingsStyles.card}>
        {timers.map((timer, index) => (
          <TimerRow
            key={`${timer.serverId}:${timer.unit}`}
            timer={timer}
            isFirst={index === 0}
            showHost={showHost}
          />
        ))}
      </View>
    </View>
  );
}

function TimerRow(props: { timer: SystemdTimer; isFirst: boolean; showHost: boolean }) {
  const { timer, isFirst, showHost } = props;
  const lastRunAgo = useTimeAgo(timer.lastRunAt ? new Date(timer.lastRunAt) : null);
  const meta = timerMeta(timer, { lastRunAgo, nextRun: formatNextRun(timer.nextRunAt), showHost });
  const badge = timerBadge(timer);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = timer.timerState !== "active";
  const toggle = useCallback(() => {
    const client = getHostRuntimeStore().getClient(timer.serverId);
    if (!client) return;
    setPending(true);
    setError(null);
    setSystemdTimerPaused(client, timer.unit, !paused)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setPending(false);
        void queryClient.invalidateQueries({ queryKey: [TIMERS_QUERY_KEY] });
      });
  }, [paused, queryClient, timer.serverId, timer.unit]);
  return (
    <View
      style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder]}
      testID={`systemd-timer-${timer.name}`}
    >
      <View style={styles.text}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {timer.name}
        </Text>
        {timer.description ? (
          <Text style={styles.description} numberOfLines={1}>
            {timer.description}
          </Text>
        ) : null}
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {meta}
        </Text>
        {error ? (
          <Text style={styles.error} numberOfLines={2}>
            {error}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        <StatusBadge label={badge.label} variant={badge.variant} />
        <DropdownMenu>
          <DropdownMenuTrigger
            hitSlop={8}
            style={kebabStyle}
            accessibilityLabel={`${timer.name} actions`}
            testID={`systemd-timer-kebab-${timer.name}`}
          >
            <ThemedKebab size={ICON_SIZE} uniProps={muted} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={200}>
            <DropdownMenuItem
              leading={paused ? resumeIcon : pauseIcon}
              status={pending ? "pending" : "idle"}
              pendingLabel={paused ? "Resuming..." : "Pausing..."}
              onSelect={toggle}
              testID={`systemd-timer-${paused ? "resume" : "pause"}-${timer.name}`}
            >
              {paused ? "Resume timer" : "Pause timer"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

const pauseIcon = <ThemedPause size={ICON_SIZE} uniProps={muted} />;
const resumeIcon = <ThemedPlay size={ICON_SIZE} uniProps={muted} />;

function kebabStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebab, hovered && styles.kebabHovered];
}

const styles = StyleSheet.create((theme) => ({
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kebab: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  error: {
    marginTop: theme.spacing[1],
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  section: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  text: {
    flex: 1,
    minWidth: 0,
    marginRight: theme.spacing[3],
  },
  description: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
