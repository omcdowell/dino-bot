import * as Clipboard from "expo-clipboard";
import { Activity, Copy } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Platform, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getOutboxSender } from "@/composer/outbox/sender";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Switch } from "@/components/ui/switch";
import {
  DINO_FIXES,
  getDinoFix,
  getDinoLayers,
  readLiveActivityIconStatus,
  setDinoFix,
  setDinoLayers,
  type DinoFix,
  type DinoLayers,
  type IconStatusResult,
  type LiveActivityIconStatus,
  type WidgetMemory,
} from "@/live-activity";
import { ScrollView } from "@/components/ui/scroll-view";
import { useToast } from "@/contexts/toast-context";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useNetworkMonitorStore, type PhoneNetworkState } from "@/runtime/network-monitor";
import { useOutboxStore } from "@/stores/outbox-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import { HostUsageSection, useHostReportsUsage } from "@/usage";
import { buildBotSyncRows, type BotSyncRow } from "./bot-sync";
import { iconStatusUnavailableText, liveActivityRowsShown } from "./live-activity-rows";
import type { HostLinks, LinkRow, LinkState } from "./model";
import { formatNetworkReport } from "./report";
import type { HostTestResult, NetworkTestRun } from "./run-tests";
import { formatMs } from "./stats";
import { startNetworkTestRun, useNetworkTestStore } from "./test-store";
import { isPublicFlavour, RELEASE_POLICY } from "@/constants/flavour";

const ThemedActivity = withUnistyles(Activity);
const ThemedCopy = withUnistyles(Copy);
const foregroundIcon = (theme: Theme) => ({ color: theme.colors.foreground });
// Phone keeps its current look (lucide's default 24 px, foreground colour): the owner is happy
// with it there. Wider layouts pass the bare icon so Button sizes and colours it like every
// other sm button (14 px, the variant's text colour).
const phoneActivityIcon = <ThemedActivity uniProps={foregroundIcon} />;
const phoneCopyIcon = <ThemedCopy uniProps={foregroundIcon} />;

function ago(at: number | null, now: number): string | null {
  return at === null ? null : formatTimeAgo(new Date(at), new Date(now));
}

function runTests(): void {
  void startNetworkTestRun();
}

export interface NetworkStatusPageProps {
  /** The host the user is looking at; it is listed first. */
  focusServerId?: string | null;
}

export function NetworkStatusPage({ focusServerId = null }: NetworkStatusPageProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const status = useNetworkStatus();
  const phone = useNetworkMonitorStore((state) => state.phone);
  const runs = useNetworkTestStore((state) => state.runs);
  const running = useNetworkTestStore((state) => state.running);
  const step = useNetworkTestStore((state) => state.step);
  const lastRun = runs[0] ?? null;
  const hosts = useMemo(
    () =>
      [...status.hosts].sort(
        (a, b) => Number(b.serverId === focusServerId) - Number(a.serverId === focusServerId),
      ),
    [focusServerId, status.hosts],
  );
  const handleCopy = useCallback(() => {
    const report = formatNetworkReport({
      status,
      phone,
      lastRun,
      now: new Date(),
    });
    void Clipboard.setStringAsync(report)
      .then(() => toast.copied(t("network.reportCopied")))
      .catch(() => toast.error(t("network.copyFailed")));
  }, [lastRun, phone, status, t, toast]);
  const isCompact = useIsCompactFormFactor();
  // Public flavour: every probe (internet targets, Tailscale, hosts) runs only from this button,
  // labelled "Test network" (privacy review 27 Oct). Nothing on this page probes by itself.
  const idleLabel = RELEASE_POLICY.networkProbesOnDemand ? "Test network" : t("network.runTests");
  const runLabel = running && step ? t(`network.steps.${step}`) : idleLabel;
  const now = Date.now();

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID="network-status"
    >
      <View style={styles.actions}>
        <Button
          variant="default"
          size="sm"
          loading={running}
          onPress={runTests}
          leftIcon={isCompact ? phoneActivityIcon : Activity}
          testID="network-run-tests"
        >
          {runLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleCopy}
          leftIcon={isCompact ? phoneCopyIcon : Copy}
          testID="network-copy-report"
        >
          {t("network.copyReport")}
        </Button>
      </View>
      <Text style={styles.muted}>
        {lastRun ? t("network.lastRun", { time: ago(lastRun.finishedAt, now) }) : neverRunText(t)}
      </Text>

      {hosts.map((host) => (
        <HostCard key={host.serverId} host={host} now={now} />
      ))}

      {lastRun ? <InternetDetails run={lastRun} /> : null}

      <Text style={styles.sectionTitle}>{t("network.sections.bots")}</Text>
      {hosts.map((host) => (
        <BotSyncList key={host.serverId} serverId={host.serverId} label={host.label} now={now} />
      ))}

      <Text style={styles.sectionTitle}>{t("network.sections.phone")}</Text>
      <PhoneDetails phone={phone} />
    </ScrollView>
  );
}

const HostCard = memo(function HostCard({ host, now }: { host: HostLinks; now: number }) {
  const { t } = useTranslation();
  // The provider row's usage: whatever usage sources the daemon has (Claude, proxy pools, …).
  const reportsUsage = useHostReportsUsage(host.serverId);
  return (
    <View style={styles.card} testID={`network-host-${host.serverId}`}>
      <Text style={styles.cardTitle}>{host.label}</Text>
      {host.rows.map((row) => (
        <LinkRowView key={row.id} row={row} hostLabel={host.label} now={now} />
      ))}
      {host.rtt.medianMs !== null ? (
        <Text style={styles.detail}>
          {t("network.rtt", {
            median: formatMs(host.rtt.medianMs),
            p95: formatMs(host.rtt.p95Ms) ?? "–",
            jitter: formatMs(host.rtt.jitterMs) ?? "–",
            loss: Math.round(host.rtt.lossPct ?? 0),
          })}
        </Text>
      ) : null}
      {host.run ? <HostRunDetails run={host.run} /> : null}
      {reportsUsage ? <HostUsageSection serverId={host.serverId} /> : null}
    </View>
  );
});

function linkTitle(
  t: (key: string, params?: Record<string, unknown>) => string,
  row: LinkRow,
  host: string,
) {
  return t(`network.links.${row.id}`, { host });
}

const LinkRowView = memo(function LinkRowView({
  row,
  hostLabel,
  now,
}: {
  row: LinkRow;
  hostLabel: string;
  now: number;
}) {
  const { t } = useTranslation();
  const reason = row.blockedBy
    ? t("network.blockedBy", {
        link: t(`network.links.${row.blockedBy}`, { host: hostLabel }),
      })
    : t(`network.reasons.${row.reason}`, row.params ?? {});
  const lastOk = row.state !== "ok" && row.lastOkAt ? ago(row.lastOkAt, now) : null;
  return (
    <View style={styles.row} testID={`network-link-${row.id}`}>
      <View style={styles.dot(row.state)} />
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {linkTitle(t, row, hostLabel)}
          </Text>
          <Text style={styles.rowLatency}>{formatMs(row.latencyMs) ?? ""}</Text>
        </View>
        <Text style={styles.rowReason}>
          {t(`network.states.${row.state}`)} · {reason}
          {lastOk ? ` · ${t("network.lastOk", { time: lastOk })}` : ""}
        </Text>
      </View>
    </View>
  );
});

function HostRunDetails({ run }: { run: HostTestResult }) {
  const { t } = useTranslation();
  const provider = run.provider;
  return (
    <View style={styles.runDetails}>
      {run.speed ? (
        <Text style={styles.detail}>
          {run.speed.error
            ? t("network.speedFailed", { error: run.speed.error })
            : t("network.speed", {
                down: run.speed.downMbps?.toFixed(2) ?? "–",
                up: run.speed.upMbps?.toFixed(2) ?? "–",
              })}
        </Text>
      ) : null}
      {provider ? (
        <Text style={styles.detail}>
          {t("network.providerTimings", {
            url: provider.viaBaseUrl ? t("network.viaProxy") : provider.url,
            dns: formatMs(provider.dnsMs) ?? "–",
            tcp: formatMs(provider.tcpMs) ?? "–",
            tls: formatMs(provider.tlsMs) ?? "–",
            http: formatMs(provider.httpMs) ?? "–",
            status: provider.httpStatus ?? provider.error ?? "–",
          })}
        </Text>
      ) : null}
      {provider?.lastProviderError ? (
        <Text style={styles.detail}>
          {t("network.lastProviderError", {
            message: provider.lastProviderError.message,
          })}
        </Text>
      ) : null}
      {provider ? <ProviderStatusBlock provider={provider} /> : null}
    </View>
  );
}

function ProviderStatusBlock({ provider }: { provider: NonNullable<HostTestResult["provider"]> }) {
  const { t } = useTranslation();
  if (!provider.status) {
    return (
      <Text style={styles.detail}>
        {t("network.statusUnavailable", { error: provider.statusError ?? "–" })}
      </Text>
    );
  }
  return (
    <View style={styles.runDetails}>
      <Text style={styles.detailStrong}>
        {t("network.sections.provider")}: {provider.status.indicator} ·{" "}
        {provider.status.description}
      </Text>
      {provider.status.components.map((component) => (
        <Text key={component.name} style={styles.detail}>
          {component.name}: {component.status.replaceAll("_", " ")}
        </Text>
      ))}
      {provider.status.incidents.map((incident) => (
        <Text key={incident.name} style={styles.detail}>
          {incident.name} ({incident.status})
          {incident.latestUpdate ? `: ${incident.latestUpdate}` : ""}
        </Text>
      ))}
    </View>
  );
}

function InternetDetails({ run }: { run: NetworkTestRun }) {
  const { t } = useTranslation();
  const trace = run.internet.trace;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t("network.sections.tests")}</Text>
      {run.internet.targets.map((target) => (
        <Text key={target.id} style={styles.detail}>
          {t("network.internetTarget", {
            label: target.label,
            median: formatMs(target.medianMs) ?? target.error ?? "–",
            ok: target.okCount,
            attempts: target.attempts,
          })}
        </Text>
      ))}
      {trace?.ip ? (
        <Text style={styles.detail}>
          {t("network.publicIp", {
            ip: trace.ip,
            loc: trace.loc ?? "–",
            colo: trace.colo ?? "–",
          })}
        </Text>
      ) : null}
    </View>
  );
}

function BotSyncList({ serverId, label, now }: { serverId: string; label: string; now: number }) {
  const { t } = useTranslation();
  const session = useSessionStore((state) => state.sessions[serverId]);
  const records = useOutboxStore((state) => state.records);
  const hostStatus = getHostRuntimeStore().getSnapshot(serverId)?.connectionStatus ?? "idle";
  const rows = useMemo(
    () =>
      session
        ? buildBotSyncRows({
            serverId,
            hostStatus,
            agents: session.agents,
            initializing: session.initializingAgents,
            historyApplied: session.agentAuthoritativeHistoryApplied,
            records,
            now,
          })
        : [],
    [hostStatus, now, records, serverId, session],
  );
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{label}</Text>
      {rows.length === 0 ? <Text style={styles.muted}>{t("network.bots.empty")}</Text> : null}
      {rows.map((row) => (
        <BotSyncRowView key={row.agentId} row={row} now={now} />
      ))}
    </View>
  );
}

const BotSyncRowView = memo(function BotSyncRowView({
  row,
  now,
}: {
  row: BotSyncRow;
  now: number;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => {
    getHostRuntimeStore().ensureConnectedAll({ verify: true });
    getOutboxSender()?.retryNow(row.serverId);
  }, [row.serverId]);
  const facts = [
    t(`network.bots.sync.${row.sync}`),
    row.status,
    t("network.bots.lastEvent", { time: ago(row.lastEventAt, now) }),
    row.waiting > 0 ? t("network.bots.outbox", { count: row.waiting }) : null,
    row.queued > 0 ? t("network.bots.queued", { count: row.queued }) : null,
    row.needsPermission ? t("network.bots.permission") : null,
  ].filter(Boolean);
  const hasPending = row.waiting > 0 || row.failed > 0;
  return (
    <View style={styles.row}>
      <View style={styles.dot(botState(row))} />
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {row.title}
          </Text>
          {hasPending ? (
            <Pressable onPress={handleRetry} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.link}>{t("network.bots.retryNow")}</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.rowReason}>{facts.join(" · ")}</Text>
        {row.lastError ? <Text style={styles.rowError}>{row.lastError}</Text> : null}
      </View>
    </View>
  );
});

function botState(row: BotSyncRow): LinkState {
  if (row.lastError || row.failed > 0) return "down";
  if (row.sync === "reconnecting" || row.waiting > 0 || row.needsPermission) return "degraded";
  return row.sync === "notLoaded" ? "unknown" : "ok";
}

/** How often the Live Activity rows are read again while the page is open: the widget writes its
 * report when it renders, which can be after the page opened. */
const ICON_STATUS_REFRESH_MS = 10_000;

/** Bot icons the Live Activity widget can read (iOS), or why this build cannot tell; null until known. */
function useLiveActivityIconStatus(): IconStatusResult | null {
  const [status, setStatus] = useState<IconStatusResult | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const value = await readLiveActivityIconStatus();
      if (live) setStatus(value);
    };
    void load();
    const timer = setInterval(() => void load(), ICON_STATUS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return status;
}

function iconStatusText(t: TFunction, icons: LiveActivityIconStatus): string {
  const counts = {
    count: icons.stored,
    avatars: icons.avatars,
    readable: icons.readable ?? "?",
  };
  return icons.lastError === null
    ? t("network.phone.liveActivityIconsStored", counts)
    : t("network.phone.liveActivityIconsError", {
        ...counts,
        code: icons.lastError,
      });
}

/** errSecItemNotFound: no keychain item. */
const ITEM_NOT_FOUND = -25300;

/** What the widget found when it last drew the icons (its own report). */
function widgetReportText(t: TFunction, icons: LiveActivityIconStatus): string {
  const report = icons.widget;
  if (!report) {
    // -25300 (or an older build that does not say): the widget never wrote one.
    const status = icons.widgetStatus;
    return status === null || status === ITEM_NOT_FOUND
      ? t("network.phone.liveActivityWidgetNone")
      : t("network.phone.liveActivityWidgetUnreadable", { code: status });
  }
  const values = {
    time: new Date(report.at * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    read: report.read,
    missing: report.missing,
    bundled: report.bundled,
  };
  const text =
    report.errors > 0
      ? t("network.phone.liveActivityWidgetError", {
          ...values,
          code: report.status,
        })
      : t("network.phone.liveActivityWidget", values);
  const refused = report.writeFailure;
  return refused
    ? `${text}${t("network.phone.liveActivityWidgetRefused", {
        count: refused.count,
        code: refused.status,
      })}`
    : text;
}

/** Whether this build shares an App Group with the widget (SharedStore.swift) and whether the
 * widget's report came from it; null before 25. */
function appGroupText(t: TFunction, icons: LiveActivityIconStatus): string | null {
  const group = icons.appGroup;
  if (!group) return null;
  if (!group.available) return t("network.phone.liveActivityAppGroupOff");
  const values = { icons: group.icons ?? 0 };
  return icons.widgetSource === "group"
    ? t("network.phone.liveActivityAppGroupOnReport", values)
    : t("network.phone.liveActivityAppGroupOn", values);
}

/** The Lock Screen dino's layers: the app's setting, the running card's, the App Group copy. */
function dinoText(t: TFunction, icons: LiveActivityIconStatus): string | null {
  const dino = icons.dino;
  if (!dino) return null;
  const none = t("network.phone.liveActivityAppearanceNone");
  return t("network.phone.liveActivityDino", {
    app: dino.app ?? none,
    card: dino.card ?? none,
    group: dino.group ?? none,
  });
}

/** Shown before the first run; the public flavour runs nothing until the user taps the button. */
function neverRunText(t: TFunction): string {
  if (RELEASE_POLICY.networkProbesOnDemand) {
    return "Not tested yet. Nothing is checked until you tap Test network.";
  }
  return t("network.neverRun");
}

/** The widget's own memory when it last reported (MB), against the limit iOS gave it. */
function widgetMemoryText(t: TFunction, memory: WidgetMemory): string {
  const values = { now: memory.now, peak: memory.peak, limit: memory.limit };
  return memory.limit === null
    ? t("network.phone.liveActivityWidgetMemoryNoLimit", values)
    : t("network.phone.liveActivityWidgetMemory", values);
}

/** The Live Activity Lock Screen dino's frame rate: 3 fps (3 timer layers, default) or 6 fps. iOS only. */
function DinoFpsSwitch() {
  const { t } = useTranslation();
  const [layers, setLayers] = useState<DinoLayers | null>(() => getDinoLayers());
  const handleChange = useCallback((six: boolean) => {
    const next: DinoLayers = six ? 6 : 3;
    setLayers(next);
    void setDinoLayers(next).then((ok) => {
      if (!ok) setLayers(getDinoLayers());
      return undefined;
    });
  }, []);
  if (layers === null) return null;
  return (
    <View style={styles.rowHeader}>
      <View style={styles.switchText}>
        <Text style={styles.detailStrong}>{t("network.phone.dinoSixFps")}</Text>
        <Text style={styles.detail}>{t("network.phone.dinoSixFpsHint")}</Text>
      </View>
      <Switch
        value={layers === 6}
        onValueChange={handleChange}
        accessibilityLabel={t("network.phone.dinoSixFps")}
        testID="network-dino-6fps-switch"
      />
    </View>
  );
}

/** The Lock Screen dino's 6 fps flicker fix (la-flicker test build): 0 = build 28, 1-3 the options
 * in the widget's DinoFix (3 by default). iOS only. */
function DinoFixPicker() {
  const { t } = useTranslation();
  const [fix, setFix] = useState<DinoFix | null>(() => getDinoFix());
  const handlePress = useCallback((next: DinoFix) => {
    setFix(next);
    void setDinoFix(next).then((ok) => {
      if (!ok) setFix(getDinoFix());
      return undefined;
    });
  }, []);
  if (fix === null) return null;
  return (
    <View>
      <View style={styles.switchText}>
        <Text style={styles.detailStrong}>{t("network.phone.dinoFix")}</Text>
        <Text style={styles.detail}>{t("network.phone.dinoFixHint")}</Text>
      </View>
      <View style={styles.dinoFixRow}>
        {DINO_FIXES.map((option) => (
          <DinoFixOption
            key={option}
            option={option}
            selected={option === fix}
            onPress={handlePress}
          />
        ))}
      </View>
    </View>
  );
}

function DinoFixOption({
  option,
  selected,
  onPress,
}: {
  option: DinoFix;
  selected: boolean;
  onPress: (option: DinoFix) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(option), [onPress, option]);
  const a11yState = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      onPress={handlePress}
      style={selected ? styles.dinoFixOptionSelected : styles.dinoFixOption}
      accessibilityRole="button"
      accessibilityState={a11yState}
      accessibilityLabel={t("network.phone.dinoFixOption", { fix: option })}
      testID={`network-dino-fix-${option}`}
    >
      <Text style={selected ? styles.dinoFixTextSelected : styles.detailStrong}>{option}</Text>
    </Pressable>
  );
}

/** Where the Lock Screen card's light/dark comes from: the app, the running card, the keychain. */
function appearanceText(t: TFunction, icons: LiveActivityIconStatus): string | null {
  const appearance = icons.appearance;
  if (!appearance) return null;
  const none = t("network.phone.liveActivityAppearanceNone");
  const values = {
    app: appearance.app ?? none,
    card: appearance.card ?? none,
    keychain: appearance.keychain ?? none,
  };
  return appearance.keychainStatus === null || appearance.keychainStatus === 0
    ? t("network.phone.liveActivityAppearance", values)
    : t("network.phone.liveActivityAppearanceError", {
        ...values,
        code: appearance.keychainStatus,
      });
}

/** The Live Activity diagnostic rows (iOS): icons, the widget's report, its memory once reported,
 * the card's appearance. */
/** Lock Screen dino debug pickers: the owner's build only (release-flavour.js). */
function DinoDebugPickers() {
  if (isPublicFlavour) return null;
  return (
    <>
      <DinoFpsSwitch />
      <DinoFixPicker />
    </>
  );
}

function liveActivityEntries(t: TFunction, result: IconStatusResult): Array<[string, string]> {
  const shown = liveActivityRowsShown({ os: Platform.OS, publicFlavour: isPublicFlavour });
  if (!shown.section) return [];
  // No status: say why rather than drop the rows (DinoBot 0.1.3 (4) showed none at all).
  if (result.status === null) {
    return [[t("network.phone.liveActivityIcons"), iconStatusUnavailableText(t, result)]];
  }
  const icons = result.status;
  // Every build: what the app stored, what the widget found, the App Group.
  const entries: Array<[string, string]> = [
    [t("network.phone.liveActivityIcons"), iconStatusText(t, icons)],
    [t("network.phone.liveActivityWidgetLabel"), widgetReportText(t, icons)],
  ];
  const appGroup = appGroupText(t, icons);
  if (appGroup) entries.push([t("network.phone.liveActivityAppGroupLabel"), appGroup]);
  // Widget internals (memory, dino layers, appearance): the owner's build only.
  if (!shown.internals) return entries;
  const memory = icons.widget?.memory;
  if (memory) {
    entries.push([t("network.phone.liveActivityWidgetMemoryLabel"), widgetMemoryText(t, memory)]);
  }
  const dino = dinoText(t, icons);
  if (dino) entries.push([t("network.phone.liveActivityDinoLabel"), dino]);
  const appearance = appearanceText(t, icons);
  if (appearance) entries.push([t("network.phone.liveActivityAppearanceLabel"), appearance]);
  return entries;
}

function PhoneDetails({ phone }: { phone: PhoneNetworkState | null }) {
  const { t } = useTranslation();
  const icons = useLiveActivityIconStatus();
  const yesNo = (value: boolean | null) =>
    value === null
      ? t("network.phone.unavailable")
      : t(value ? "network.phone.yes" : "network.phone.no");
  const entries: Array<[string, string]> = [
    [t("network.phone.type"), phone?.type ?? t("network.phone.unavailable")],
    [t("network.phone.expensive"), yesNo(phone?.isExpensive ?? null)],
  ];
  if (phone?.cellularGeneration)
    entries.push([t("network.phone.cellularGeneration"), phone.cellularGeneration]);
  if (phone?.carrier) entries.push([t("network.phone.carrier"), phone.carrier]);
  if (phone?.ipAddress) entries.push([t("network.phone.ipAddress"), phone.ipAddress]);
  if (phone?.wifiStrength !== null && phone?.wifiStrength !== undefined) {
    entries.push([t("network.phone.wifiStrength"), `${phone.wifiStrength}%`]);
  }
  if (phone?.wifiFrequency)
    entries.push([t("network.phone.wifiFrequency"), `${phone.wifiFrequency} MHz`]);
  if (phone?.linkSpeedMbps)
    entries.push([t("network.phone.linkSpeed"), `${phone.linkSpeedMbps} Mbit/s`]);
  if (icons) entries.push(...liveActivityEntries(t, icons));
  return (
    <View style={styles.card}>
      {entries.map(([label, value]) => (
        <View key={label} style={styles.rowHeader}>
          <Text style={styles.detail}>{label}</Text>
          <Text style={styles.detailValue}>{value}</Text>
        </View>
      ))}
      <DinoDebugPickers />
    </View>
  );
}

function dotColor(theme: Theme, state: LinkState): string {
  switch (state) {
    case "ok":
      return theme.colors.statusSuccess;
    case "degraded":
    case "checking":
      return theme.colors.statusWarning;
    case "down":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    marginTop: theme.spacing[2],
  },
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  dot: (state: LinkState) => ({
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
    backgroundColor: dotColor(theme, state),
  }),
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowLatency: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  rowReason: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  runDetails: {
    gap: 2,
  },
  switchText: {
    flexShrink: 1,
    gap: 2,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detailStrong: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  dinoFixRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  dinoFixOption: {
    flex: 1,
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  dinoFixOptionSelected: {
    flex: 1,
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    backgroundColor: theme.colors.accentBright,
    borderColor: theme.colors.accentBright,
  },
  dinoFixTextSelected: {
    color: theme.colors.background,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  // A long value (the Live Activity rows) wraps inside the card instead of running past its edge.
  detailValue: {
    flexShrink: 1,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  link: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.sm,
  },
}));
