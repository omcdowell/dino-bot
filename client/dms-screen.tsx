import { useRpc, useWorkspace, type PluginScreenProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { dmsReplyRpc, dmsThreadRpc, dmsThreadsRpc, type DmThreadSummary, type DmView } from "../shared/dm-rpc";
import { DM_MAX_BODY } from "../shared/dm-schema";
import { botsListRpc, botsOpenRpc } from "../shared/rpc";
import { BOTS_QUERY_KEY } from "./sidebar";
import { useDmFocus } from "./dms-focus";
import { openChatPatiently, startingLabel } from "./bot-open";
import {
  DMS_KEY,
  botForDirectory,
  HOP_WARN,
  THREAD_POLL_MS,
  THREADS_POLL_MS,
  dmsThreadKey,
  dmsThreadsKey,
  longTime,
  partyLabel,
  shortTime,
  statusLabel,
  titleCase,
} from "./dms-format";
import { accentFill, accentOn, accentText } from "./accent";

type Colors = PluginTheme["colors"];
type ThreadRef = { threadId?: string; messageId?: string };
type Names = ReadonlyMap<string, string>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Badge({ label, color, c, filled }: { label: string; color: string; c: Colors; filled?: boolean }) {
  return (
    <View
      style={{
        borderRadius: 6,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: filled ? color : "transparent",
        paddingHorizontal: 5,
        paddingVertical: 1,
        marginRight: 6,
        marginTop: 4,
      }}
    >
      <Text style={{ color: filled ? accentOn(c) : color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

function Button({ label, onPress, c, primary, disabled }: { label: string; onPress: () => void; c: Colors; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        marginLeft: 8,
        backgroundColor: primary ? accentFill(c) : c.surface2,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: primary ? accentOn(c) : c.foreground, fontWeight: "600", fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function ThreadBadges({ t, c }: { t: DmThreadSummary; c: Colors }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      <Badge label={t.kind} color={t.kind === "escalate" ? c.statusWarning : c.foregroundMuted} c={c} />
      {t.count > 1 ? <Badge label={`${t.count} msgs`} color={c.foregroundMuted} c={c} /> : null}
      {t.max_hop > 1 ? <Badge label={`hop ${t.max_hop}`} color={t.max_hop >= HOP_WARN ? c.statusDanger : c.foregroundMuted} c={c} /> : null}
      {t.awaiting_reply ? <Badge label="awaiting reply" color={accentText(c)} c={c} /> : null}
      {t.has_problem ? <Badge label={t.last_status === "refused" ? "refused" : "problem"} color={c.statusDanger} c={c} /> : null}
    </View>
  );
}

function ThreadList({
  threads,
  selected,
  onSelect,
  c,
  footer,
  names,
}: {
  names: Names;
  threads: DmThreadSummary[];
  selected: string | null;
  onSelect: (thread: string) => void;
  c: Colors;
  footer?: ReactNode;
}) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
      {threads.map((t) => {
        const active = t.thread === selected;
        return (
          <Pressable
            key={t.thread}
            accessibilityRole="button"
            onPress={() => onSelect(t.thread)}
            style={({ pressed }) => ({
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderBottomWidth: 1,
              borderBottomColor: c.border,
              backgroundColor: active ? c.surface2 : pressed ? c.surface1 : "transparent",
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", flex: 1 }}>
                {t.parties.map((p) => partyLabel(p, names)).join(", ") || "—"}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 12, marginLeft: 8 }}>{shortTime(t.last_ts)}</Text>
            </View>
            <Text numberOfLines={1} style={{ color: c.foregroundMuted, marginTop: 2 }}>
              {t.subject || "(no subject)"}
            </Text>
            <ThreadBadges t={t} c={c} />
          </Pressable>
        );
      })}
      {footer}
    </ScrollView>
  );
}

function MessageBubble({ m, c, names }: { m: DmView; c: Colors; names: Names }) {
  const fromUser = m.from === "user";
  const out = m.direction === "out";
  const status = statusLabel(m.status, m.status_detail);
  const bad = m.status === "refused" || m.status === "failed";
  return (
    <View style={{ alignItems: out ? "flex-end" : "flex-start", marginVertical: 6 }}>
      <View
        style={{
          maxWidth: "92%",
          borderRadius: 10,
          padding: 10,
          backgroundColor: out ? c.surface2 : c.surface1,
          borderWidth: 1,
          borderColor: bad ? c.statusDanger : fromUser ? accentText(c) : m.kind === "escalate" ? c.statusWarning : c.border,
        }}
      >
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          <Text style={{ color: c.foreground, fontWeight: "700" }}>{partyLabel(m.from, names)}</Text>
          {` → ${partyLabel(m.to, names)} · ${m.kind} · `}
          <Text style={{ color: m.hop >= HOP_WARN ? c.statusDanger : c.foregroundMuted }}>{`hop ${m.hop}`}</Text>
          {` · ${longTime(m.ts)}`}
        </Text>
        {m.subject && !m.body.startsWith(m.subject) ? (
          <Text style={{ color: c.foreground, fontWeight: "600", marginTop: 6 }}>{m.subject}</Text>
        ) : null}
        <Text selectable style={{ color: c.foreground, marginTop: 6, lineHeight: 20 }}>
          {m.body}
        </Text>
        {m.attachments.length ? (
          <View style={{ marginTop: 6 }}>
            {m.attachments.map((path) => (
              <Text key={path} selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>
                File: {path}
              </Text>
            ))}
          </View>
        ) : null}
        <Text style={{ color: bad ? c.statusDanger : c.foregroundMuted, fontSize: 11, marginTop: 6 }}>
          {[status, m.expects_reply ? "expects reply" : null].filter(Boolean).join(" · ") || (fromUser ? "Sent to chat" : " ")}
        </Text>
      </View>
    </View>
  );
}

function ThreadView({
  botId,
  name,
  threadRef,
  c,
  compact,
  onBack,
  onResolved,
  names,
}: {
  /** Called with the thread id when the view was opened by message id. */
  onResolved?: (threadId: string) => void;
  names: Names;
  botId: string;
  name: string;
  threadRef: ThreadRef;
  c: Colors;
  compact: boolean;
  onBack?: () => void;
}) {
  const fetchThread = useRpc(dmsThreadRpc);
  const reply = useRpc(dmsReplyRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<{ scrollToEnd(options?: { animated?: boolean }): void } | null>(null);
  const ref = threadRef.threadId ?? threadRef.messageId ?? "";
  const { data, error, isLoading } = useQuery({
    queryKey: dmsThreadKey(botId, ref),
    queryFn: () => fetchThread({ botId, ...threadRef }),
    refetchInterval: THREAD_POLL_MS,
  });
  const thread = data?.thread ?? null;
  const messages = data?.messages ?? [];

  useEffect(() => {
    if (thread && !threadRef.threadId) onResolved?.(thread.thread);
  }, [thread?.thread, threadRef.threadId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !thread || sending) return;
    setSending(true);
    try {
      const result = await reply({ botId, threadId: thread.thread, text });
      setDraft("");
      if (result.warning) toast.show(result.warning, { variant: "warning", durationMs: 5000 });
      else toast.show(`Sent to ${name}`, { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: DMS_KEY });
    } catch (e) {
      toast.error(`Not sent: ${errorText(e)}`);
    } finally {
      setSending(false);
    }
  };

  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back to threads" onPress={onBack} style={{ paddingRight: 12, paddingVertical: 4 }}>
          <Text style={{ color: accentText(c), fontWeight: "600" }}>‹ Threads</Text>
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "700" }}>
          {thread?.subject || (isLoading ? "Loading…" : "Thread")}
        </Text>
        {thread ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {[name, ...thread.parties.map((p) => partyLabel(p, names))].join(" · ")}
          </Text>
        ) : null}
      </View>
    </View>
  );

  if (error) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <Text style={{ color: c.statusDanger, padding: 16 }}>{errorText(error)}</Text>
      </View>
    );
  }
  if (!isLoading && !thread) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <Text style={{ color: c.foregroundMuted, padding: 16 }}>
          This DM is not in {name}'s ledger (it may be older than the part the view reads, or was sent before the ledger existed).
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {header}
      <ScrollView
        ref={scroller as never}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: compact ? 10 : 16 }}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      >
        {isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} c={c} names={names} />
        ))}
      </ScrollView>
      {thread ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, padding: 10, backgroundColor: c.surface1 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={DM_MAX_BODY}
              editable={!sending}
              placeholder={`Reply to ${name} as yourself…`}
              placeholderTextColor={c.foregroundMuted}
              accessibilityLabel={`Reply to ${name}`}
              style={{
                flex: 1,
                minHeight: 40,
                maxHeight: 160,
                color: c.foreground,
                backgroundColor: c.surface0,
                borderColor: c.border,
                borderWidth: 1,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
              }}
            />
            <Button label={sending ? "Sending…" : "Send"} onPress={() => void send()} c={c} primary disabled={!draft.trim() || sending} />
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 11, marginTop: 6 }}>
            Goes into {name}'s chat as your message, quoting this thread. If {name} is busy it lands after the current tool call.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

type Navigation = PluginScreenProps["navigation"];

/**
 * The DMs view itself, shared by the Explorer panel and the phone screen. One column (thread list,
 * then a thread with "‹ Threads") when narrow; list and thread side by side when wide.
 */
export function DmsView({
  botId,
  name,
  names,
  c,
  twoColumn,
  showTitle,
  inPanel,
  navigation,
  focus,
}: {
  botId: string;
  name: string;
  names: Names;
  c: Colors;
  twoColumn: boolean;
  /** The phone screen's header already says "<bot> · DMs"; the Explorer tab says "DMs". */
  showTitle: boolean;
  /** In the Explorer the tab only says "DMs", so the toolbar names the bot. */
  inPanel?: boolean;
  /** Present: show "Open chat" (the screen; the panel already sits beside the bot's chat). */
  navigation?: Navigation;
  /** A thread to select; a new `seq` selects again (a timeline card tapped twice). */
  focus: { ref: ThreadRef; seq: number } | null;
}) {
  const fetchThreads = useRpc(dmsThreadsRpc);
  const openChat = useRpc(botsOpenRpc);
  const toast = useToast();
  const [selected, setSelected] = useState<ThreadRef | null>(focus?.ref ?? null);
  // Another bot, or a card asking for another thread, selects the new target.
  useEffect(() => setSelected(focus?.ref ?? null), [botId, focus?.seq]);

  const { data, error, isLoading } = useQuery({
    queryKey: dmsThreadsKey(botId),
    queryFn: () => fetchThreads({ botId }),
    refetchInterval: THREADS_POLL_MS,
    enabled: !!botId,
  });
  const threads = data?.threads ?? [];
  const skipped = data?.skipped;
  // Side by side, show the newest thread rather than an empty pane.
  const shown: ThreadRef | null = selected ?? (twoColumn && threads[0] ? { threadId: threads[0].thread } : null);

  const goToChat = async () => {
    if (!navigation) return;
    try {
      const result = await openChatPatiently(() => openChat({ botId }), { onStarting: () => toast.show(startingLabel(name)) });
      navigation.openAgent({ agentId: result.agentId });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const toolbar = (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: inPanel ? 8 : 10, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface0 }}>
      <View style={{ flex: 1 }}>
        {showTitle ? <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>{name} · DMs</Text> : null}
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {isLoading ? "Loading…" : `${inPanel ? `${name} · ` : ""}${threads.length} thread${threads.length === 1 ? "" : "s"}`}
        </Text>
      </View>
      {navigation ? <Button label="Open chat" onPress={() => void goToChat()} c={c} primary /> : null}
    </View>
  );

  const footer =
    skipped && (skipped.invalid || skipped.truncated) ? (
      <Text style={{ color: c.foregroundMuted, fontSize: 11, padding: 14 }}>
        {[skipped.invalid ? `${skipped.invalid} unreadable ledger line${skipped.invalid === 1 ? "" : "s"} skipped.` : null, skipped.truncated ? "Older DMs are not shown (the view reads the last 256 KB)." : null]
          .filter(Boolean)
          .join(" ")}
      </Text>
    ) : null;

  const list = error ? (
    <Text style={{ color: c.statusDanger, padding: 16 }}>{errorText(error)}</Text>
  ) : !isLoading && !threads.length ? (
    <Text style={{ color: c.foregroundMuted, padding: 16 }}>No DMs for {name} yet.</Text>
  ) : (
    <ThreadList names={names} threads={threads} selected={shown?.threadId ?? null} onSelect={(thread) => setSelected({ threadId: thread })} c={c} footer={footer} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      {toolbar}
      {!twoColumn ? (
        shown ? (
          <ThreadView key={JSON.stringify(shown)} onResolved={(threadId) => setSelected({ threadId })} names={names} botId={botId} name={name} threadRef={shown} c={c} compact onBack={() => setSelected(null)} />
        ) : (
          list
        )
      ) : (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ width: 340, borderRightWidth: 1, borderRightColor: c.border }}>{list}</View>
          <View style={{ flex: 1 }}>
            {shown ? (
              <ThreadView key={JSON.stringify(shown)} onResolved={(threadId) => setSelected({ threadId })} names={names} botId={botId} name={name} threadRef={shown} c={c} compact={false} />
            ) : (
              <Text style={{ color: c.foregroundMuted, padding: 16 }}>Pick a thread.</Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/** Bot display names, from the same query (and cache) as the sidebar's bot list. */
function useBots() {
  const listBots = useRpc(botsListRpc);
  const { data, isLoading, error } = useQuery({ queryKey: BOTS_QUERY_KEY, queryFn: () => listBots({}), staleTime: 30_000 });
  const bots = data?.bots ?? [];
  const names: Names = new Map(bots.map((b) => [b.id, b.name]));
  return { bots, names, isLoading, error };
}

/**
 * Phone fallback: the iOS app (and narrow web) draws the Explorer with built-in tabs only, so
 * plugin panels cannot appear there. Reached from the DMs rows in the Bots sidebar and from DM cards.
 */
export function DmsScreen({ theme, params, navigation, layout }: PluginScreenProps) {
  const c = theme.colors;
  const botId = params.botId ?? "";
  const { names } = useBots();
  const name = params.name ?? names.get(botId) ?? titleCase(botId);
  const ref: ThreadRef | null = params.thread ? { threadId: params.thread } : params.message ? { messageId: params.message } : null;
  const seq = useRef(0);
  const focus = useMemo(() => (ref ? { ref, seq: ++seq.current } : null), [params.thread, params.message]);

  if (!botId) {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0, padding: 24 }}>
        <Text style={{ color: c.foregroundMuted }}>No bot selected.</Text>
      </View>
    );
  }
  return <DmsView botId={botId} name={name} names={names} c={c} twoColumn={!layout.compact} showTitle={!layout.compact} navigation={navigation} focus={focus} />;
}

/** Wide enough for list and thread side by side (an Explorer dragged very wide). */
const PANEL_TWO_COLUMN_MIN = 760;

/** Explorer panel ("DMs", next to Files and Changes): the DMs of the bot whose workspace is open. */
export function DmsPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const c = theme.colors;
  const directory = useWorkspace(workspaceId, (w) => w.directory);
  const { bots, names, isLoading, error } = useBots();
  const bot = botForDirectory(bots, directory);
  const focus = useDmFocus(bot?.id ?? "");
  const [width, setWidth] = useState(0);

  let body: ReactNode;
  if (bot) {
    body = <DmsView botId={bot.id} name={bot.name} names={names} c={c} twoColumn={width >= PANEL_TWO_COLUMN_MIN} showTitle={false} inPanel focus={focus} />;
  } else if (error) {
    body = <Text style={{ color: c.statusDanger, padding: 16 }}>{errorText(error)}</Text>;
  } else if (isLoading || directory === null) {
    body = <ActivityIndicator style={{ marginTop: 24 }} color={c.foregroundMuted} />;
  } else {
    body = (
      <View style={{ padding: 16 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>Not a bot workspace</Text>
        <Text style={{ color: c.foregroundMuted, marginTop: 6, fontSize: 12 }}>
          DMs show in a bot's own workspace ({directory || "this folder"} is not under the bots folder).
        </Text>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {body}
    </View>
  );
}
