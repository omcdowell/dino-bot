/**
 * Group chat screen (plugin screen `group`, params `{ groupId, name }`), mockup picks:
 * - 2A bubbles (13 Oct): the owner's bubble on the right with a "→ who got it" line from the
 *   router; each bot message in a bubble with the bot's avatar beside it (no disc) and its name inside;
 *   a bot's follow-ups within 2 min share one avatar and name; hand-over markers; system lines.
 * - Composer: a "To …" hint that is always shown (same mention rules as the router), an @ picker,
 *   and the Paseo mic beside @ on app builds that lend plugins their dictation (group-dictation.ts).
 * - Group info (4): a sheet from the people button. Laptop (5): a Members panel on the right.
 *
 * Header: on phones with a Paseo build that has `mobileFloatingHeader`, header D (group-header.tsx:
 * avatars + name, people button). Elsewhere the app's plain plugin ScreenHeader ("Alarm Clock"),
 * with the people button in a slim bar under it.
 */
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
// Namespace import so the dictation API can be looked up: it is missing on older apps.
import * as pluginReactNative from "@getpaseo/plugin/client/react-native";
// Same for the host's Markdown (Paseo builds with the plugin Markdown component).
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  // The transcript: the host hands plugins a `react-native` ScrollView that leaves room under header D
  // (iOS: a native top content inset; elsewhere: top padding in place of the plugin's own).
  ScrollView as InsetScrollView,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { HOP_CAP, LEAD_ASSIGN_CAP, leadsFirst, type Group, type RoomMessage } from "../shared/rooms/schema";
import { ROOM_POST_MAX } from "../shared/rooms/rpc";
import type { RoomMemberState, RoomSummary } from "./group-types";
import { botsOpenRpc, type Bot } from "../shared/rpc";
import { BotAvatar, type AvatarSource } from "./bot-avatar";
import { BOTS_QUERY_KEY, useBotsData } from "./bot-data";
import { useKeyboardInset } from "./keyboard-inset";
import { useSwipeDownDismiss } from "./swipe-dismiss";
import { hostDictation, insertDictation, showsDictationOverlay, type HostDictation } from "./group-dictation";
import { useGroupInfoRequests } from "./group-header";
import { pendingArrived, startPending, type PendingPost } from "./group-pending";
import { openChatPatiently, startingLabel } from "./bot-open";
import { AvatarRow, GroupAvatar } from "./group-avatar";
import { accentFill, accentOn, accentText } from "./accent";
import {
  avatarFor,
  namesFor,
  toGroup,
  usePostToRoom,
  useRoomsList,
  useRoomsSeen,
  useRoomThread,
  useSetMembers,
} from "./group-data";
import {
  activeMention,
  addableBots,
  applyMemberOp,
  avatarStack,
  assignTargets,
  composerHint,
  composerPost,
  displayName,
  sendButton,
  groupSubtitle,
  insertMention,
  leadsLabel,
  leadToggleBlocked,
  memberBusy,
  memberLine,
  memberStatus,
  hasMarkdown,
  mentionSpans,
  MAX_MEMBERS,
  removeBlocked,
  type MemberOp,
  pickerRows,
  newestScrollOffset,
  quietLine,
  threadItems,
  typingLine,
  type ActiveMention,
  type Names,
  type PickerRow,
  type Segment,
  type ThreadItem,
} from "./group-format";

type Colors = PluginTheme["colors"];
type Navigation = PluginScreenProps["navigation"];

/** Max width of the thread column on wide layouts (mockup 5). */
const THREAD_MAX = 760;
const PANEL_WIDTH = 300;
/** Composer text limit: the server's `rooms.post` maximum. */
const MAX_DRAFT = ROOM_POST_MAX;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Send button, copied from the app's bot-chat composer (packages/app/src/composer/input/input.tsx,
 * `styles.sendButton` + `buttonDisabled`, `buttonIconSize`): a 28 pt accent circle, ArrowUp in
 * accentForeground (16 on web, 20 on phones: ICON_SIZE.md / .lg), 4 pt (spacing[1]) left margin,
 * opacity 0.5 while disabled. Colours are the theme's accent tokens, except that on the dino green
 * the plugin fills it dino green with a dark ink arrow (accentFill / accentOn).
 */
const SEND_SIZE = 28;
const SEND_MARGIN_LEFT = 4;
const SEND_DISABLED_OPACITY = 0.5;
const sendIconSize = (web: boolean) => (web ? 16 : 20);

/** Muted text one step fainter (the mockups' foregroundSubtle; not a plugin theme token). */
const subtle = { opacity: 0.7 } as const;

function Segments({ segments, c, strongColor }: { segments: Segment[]; c: Colors; strongColor?: string }) {
  return (
    <>
      {segments.map((s, i) =>
        s.strong ? (
          <Text key={i} style={{ color: strongColor ?? c.foreground, fontWeight: "600" }}>
            {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </>
  );
}

// ---------- context for opening a bot's main chat ----------

type Ctx = {
  theme: PluginTheme;
  c: Colors;
  group: Group;
  summary: RoomSummary | undefined;
  names: Names;
  bots: readonly Bot[];
  avatar(botId: string): AvatarSource;
  openMain(botId: string, agentId?: string | null): void;
};

function useOpenMain(navigation: Navigation, bots: readonly Bot[]) {
  const openChat = useRpc(botsOpenRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  return (botId: string, agentId?: string | null) => {
    if (!navigation) {
      toast.error("This Paseo app is too old to open chats from plugins. Update the app.");
      return;
    }
    const known = agentId ?? bots.find((b) => b.id === botId)?.agentId;
    if (known) {
      navigation.openAgent({ agentId: known });
      return;
    }
    const name = bots.find((b) => b.id === botId)?.name ?? botId;
    openChatPatiently(() => openChat({ botId }), { onStarting: () => toast.show(startingLabel(name)) })
      .then((result) => {
        if (result.created) void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY });
        navigation.openAgent({ agentId: result.agentId });
      })
      .catch((cause: unknown) => toast.error(errorText(cause)));
  };
}

// ---------- transcript ----------

function UserBubble({ msg, delivery, ctx, pending }: { msg: { text: string }; delivery: string; ctx: Ctx; pending?: boolean }) {
  const { c } = ctx;
  return (
    <View style={{ alignItems: "flex-end" }}>
      <View
        style={{
          maxWidth: "82%",
          backgroundColor: c.surface2,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 2,
          borderBottomLeftRadius: 16,
          borderBottomRightRadius: 16,
          paddingVertical: 10,
          paddingHorizontal: 14,
          opacity: pending ? 0.6 : 1,
          overflow: "hidden",
        }}
      >
        {/* One step above the bots' surface2 bubbles (the mockup's surface3, not a plugin token). */}
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: c.foreground, opacity: 0.08 }}
        />
        <Text selectable style={{ color: c.foreground, fontSize: 15, lineHeight: 22 }}>
          <Segments segments={mentionSpans(msg.text, ctx.group, ctx.names)} c={c} strongColor={accentText(c)} />
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 5, gap: 4 }}>
        <View style={subtle}>
          <Icon name="ArrowRight" size={12} color={c.foregroundMuted} />
        </View>
        <Text style={[{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }, subtle]}>{delivery}</Text>
      </View>
    </View>
  );
}

/** Bubble avatar (2A): the plain line-art image, no disc; beside the last bubble of a run. */
const BUBBLE_AVATAR = 28;
const BUBBLE_GAP = 8;

function BotMessage({ item, ctx }: { item: Extract<ThreadItem, { kind: "bot" }>; ctx: Ctx }) {
  const { c } = ctx;
  return (
    <View
      accessibilityLabel={item.header ? `${item.name}, ${item.time}` : undefined}
      style={{ flexDirection: "row", alignItems: "flex-end", gap: BUBBLE_GAP, maxWidth: "86%" }}
    >
      <View style={{ width: BUBBLE_AVATAR, height: BUBBLE_AVATAR }}>
        {item.tail ? <BotAvatar bot={ctx.avatar(item.msg.from)} size={BUBBLE_AVATAR} theme={ctx.theme} /> : null}
      </View>
      <View
        style={{
          flexShrink: 1,
          backgroundColor: c.surface2,
          borderTopLeftRadius: item.header ? 16 : 6,
          borderTopRightRadius: 16,
          borderBottomRightRadius: 16,
          borderBottomLeftRadius: item.tail ? 2 : 6,
          paddingTop: 8,
          paddingBottom: 9,
          paddingHorizontal: 12,
        }}
      >
        {item.header ? (
          <Text style={{ color: c.foreground, fontSize: 12, lineHeight: 16, fontWeight: "600", marginBottom: 1 }}>
            {item.name}
            {ctx.group.leads.includes(item.msg.from) ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}> · lead</Text> : null}
          </Text>
        ) : null}
        {item.reLine ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, marginBottom: 2 }}>{item.reLine}</Text>
        ) : null}
        {HostMarkdown && hasMarkdown(item.msg.text) ? (
          <HostMarkdown>{item.msg.text}</HostMarkdown>
        ) : (
          <Text selectable style={{ color: c.foreground, fontSize: 15, lineHeight: 22 }}>
            <Segments segments={mentionSpans(item.msg.text, ctx.group, ctx.names)} c={c} strongColor={accentText(c)} />
          </Text>
        )}
      </View>
    </View>
  );
}

/** The host's Markdown renderer, as in direct chats; undefined on older apps (plain text then). */
const HostMarkdown = (pluginUi as { Markdown?: ComponentType<{ children: string }> }).Markdown;

function HandoverMarker({ item, ctx }: { item: Extract<ThreadItem, { kind: "handover" }>; ctx: Ctx }) {
  const { c } = ctx;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        item.from ? `${item.name} took ${item.from}'s task to their main chat. Open` : `${item.name} took this to their main chat. Open`
      }
      onPress={() => ctx.openMain(item.bot, item.agentId)}
      style={({ pressed }) => ({
        marginLeft: BUBBLE_AVATAR + BUBBLE_GAP,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: pressed ? c.surface2 : c.surface1,
        borderWidth: 1,
        borderColor: c.border,
      })}
    >
      <Icon name="CornerUpRight" size={16} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>{item.name}</Text>
        {item.from ? (
          <>
            {" took "}
            <Text style={{ color: c.foreground, fontWeight: "600" }}>{item.from}</Text>
            {"'s task"}
          </>
        ) : (
          " took this to their main chat"
        )}
      </Text>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>Open</Text>
      <Icon name="ChevronRight" size={14} color={c.foreground} />
    </Pressable>
  );
}

const SYSTEM_ICONS = { check: "Check", alert: "CircleAlert", pause: "CirclePause", info: "Info" } as const;

function SystemLine({ text, icon, c }: { text: string; icon: keyof typeof SYSTEM_ICONS; c: Colors }) {
  return (
    <View style={[{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 5, paddingHorizontal: 16 }, subtle]}>
      <Icon name={SYSTEM_ICONS[icon]} size={13} color={icon === "alert" ? c.statusDanger : c.foregroundMuted} />
      <Text style={{ color: icon === "alert" ? c.statusDanger : c.foregroundMuted, fontSize: 12, lineHeight: 16, textAlign: "center" }}>
        {text}
      </Text>
    </View>
  );
}

function Transcript({
  ctx,
  messages,
  members,
  pending,
  isLoading,
  error,
  now,
  headerInset,
}: {
  ctx: Ctx;
  messages: RoomMessage[];
  members: RoomMemberState[];
  pending: { text: string; delivery: string } | null;
  isLoading: boolean;
  error: unknown;
  now: number;
  /** Header D's height (`floatingHeaderInset`); the host's ScrollView already leaves it free. */
  headerInset?: number;
}) {
  const { c } = ctx;
  const items = useMemo(() => threadItems(messages, ctx.group, ctx.names), [messages, ctx.group, ctx.names]);
  const quiet = quietLine(messages, members, now);
  const scroller = useRef<{
    scrollToEnd(options?: { animated?: boolean }): void;
    scrollTo(options: { y: number; animated?: boolean }): void;
  } | null>(null);
  // Follow new lines only while the owner is at the bottom; reading older lines is not interrupted.
  const atBottom = useRef(true);
  const size = useRef({ content: 0, viewport: 0 });
  // iOS only: there the host's room is a content inset that `scrollToEnd` ignores (it stops at 0).
  const topInset = Platform.OS === "ios" ? (headerInset ?? 0) : 0;
  const toNewest = () => {
    const y = newestScrollOffset({ contentHeight: size.current.content, viewportHeight: size.current.viewport, topInset });
    if (y === null) scroller.current?.scrollToEnd({ animated: false });
    else scroller.current?.scrollTo({ y, animated: false });
  };
  return (
    <InsetScrollView
      ref={scroller as never}
      style={{ flex: 1 }}
      // The 16 pt top gap is on the inner column: on Android and web the host's header room replaces
      // this container's paddingTop rather than adding to it.
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
      keyboardShouldPersistTaps="handled"
      // Dragging the thread down pulls the keyboard away with the finger (iOS; Android closes it).
      keyboardDismissMode="interactive"
      scrollEventThrottle={100}
      onScroll={(e) => {
        const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
        atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
      }}
      onContentSizeChange={(_w, h) => {
        size.current.content = h;
        if (atBottom.current) toNewest();
      }}
      // The keyboard shrinks the thread: keep the newest line in view if it was.
      onLayout={(e) => {
        size.current.viewport = e.nativeEvent.layout.height;
        if (atBottom.current) toNewest();
      }}
    >
      <View style={{ paddingTop: 16, gap: 14 }}>
      {isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}
      {error ? <Text style={{ color: c.statusDanger }}>{errorText(error)}</Text> : null}
      {!isLoading && !error && !items.length && !pending ? (
        <Text style={{ color: c.foregroundMuted, textAlign: "center", marginTop: 24, fontSize: 14 }}>
          No messages yet. Every message goes to {leadsLabel(ctx.group, ctx.names)}; @name wakes others too.
        </Text>
      ) : null}
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserBubble key={item.key} msg={item.msg} delivery={item.delivery} ctx={ctx} />;
          case "bot":
            // A run's later bubbles sit 4 pt under the one above (the list gap is 14).
            return (
              <View key={item.key} style={item.header ? undefined : { marginTop: -10 }}>
                <BotMessage item={item} ctx={ctx} />
              </View>
            );
          case "handover":
            return <HandoverMarker key={item.key} item={item} ctx={ctx} />;
          case "system":
            return <SystemLine key={item.key} text={item.text} icon={item.icon} c={c} />;
        }
      })}
      {pending ? <UserBubble msg={pending} delivery={pending.delivery} ctx={ctx} pending /> : null}
      {quiet ? <SystemLine text={quiet} icon="check" c={c} /> : null}
      </View>
    </InsetScrollView>
  );
}

// ---------- typing line ----------

function TypingDots({ c }: { c: Colors }) {
  return (
    <View style={{ flexDirection: "row", gap: 3, marginLeft: 6 }}>
      {[1, 0.65, 0.35].map((opacity) => (
        <View key={opacity} style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: c.foregroundMuted, opacity }} />
      ))}
    </View>
  );
}

function TypingLine({ ctx, members }: { ctx: Ctx; members: RoomMemberState[] }) {
  const line = typingLine(members, ctx.group, ctx.names);
  if (!line) return null;
  const { c } = ctx;
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 8, gap: 6 }}>
      <BotAvatar bot={ctx.avatar(line.first)} size={18} theme={ctx.theme} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 13 }}>
        <Segments segments={line.segments} c={c} />
      </Text>
      <TypingDots c={c} />
    </View>
  );
}

// ---------- composer + @ picker ----------

function PickerCard({
  rows,
  highlight,
  ctx,
  onPick,
}: {
  rows: PickerRow[];
  highlight: number;
  ctx: Ctx;
  onPick(row: PickerRow): void;
}) {
  const { c } = ctx;
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 8,
        padding: 4,
        borderRadius: 12,
        backgroundColor: c.surface1,
        borderWidth: 1,
        borderColor: c.border,
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
      }}
    >
      {rows.map((row, i) => (
        <Pressable
          key={row.id}
          accessibilityRole="button"
          accessibilityLabel={row.kind === "all" ? `Everyone, wake every member` : `${row.name}${row.lead ? ", lead" : ""}, ${row.status}`}
          onPress={() => onPick(row)}
          style={({ pressed }) => ({
            minHeight: 48,
            borderRadius: 8,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            gap: 12,
            backgroundColor: i === highlight || pressed ? c.surface2 : "transparent",
          })}
        >
          {row.kind === "all" ? (
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
              <Icon name="Users" size={16} color={c.foreground} />
            </View>
          ) : (
            <BotAvatar bot={ctx.avatar(row.id)} size={32} theme={ctx.theme} />
          )}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: c.foreground, fontSize: 15 }}>{row.kind === "all" ? "@all" : row.name}</Text>
              {row.kind === "member" && row.lead ? <LeadTag c={c} /> : null}
            </View>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {row.kind === "all" ? `Wake every member (${row.count})` : row.status}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function LeadTag({ c }: { c: Colors }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: c.surface2, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
      <Icon name="Crown" size={11} color={c.foregroundMuted} />
      <Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "600" }}>lead</Text>
    </View>
  );
}

// The app's dictation, fixed for the life of the bundle, so the hook below is always (or never) called.
const DICTATION = hostDictation(pluginReactNative);
const useMic: (options: { serverId: string; onTranscript(text: string): void }) => HostDictation | null =
  DICTATION ? DICTATION.usePluginDictation : () => null;

function Composer({
  ctx,
  members,
  serverId,
  phone,
  web,
  keyboardOpen,
  onSend,
}: {
  ctx: Ctx;
  members: RoomMemberState[];
  /** The host that transcribes the mic. */
  serverId: string;
  /** Phone layout: room for the home indicator under the box. */
  phone: boolean;
  /** Enter sends, Shift+Enter breaks the line; arrows move in the picker. */
  web: boolean;
  /** The keyboard is up: the box sits on it, no home-indicator gap. */
  keyboardOpen: boolean;
  onSend(text: string, opts: { assign: boolean }): Promise<boolean>;
}) {
  const { c, group, names } = ctx;
  const [draft, setDraft] = useState("");
  /** Assign toggle: off by default, shown only while the draft @names a member, reset after each send. */
  const [assignOn, setAssignOn] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const input = useRef<{ focus(): void } | null>(null);

  // Dictated text goes in at the cursor; "insert and send" sends the draft it lands in.
  const latest = useRef({ draft, cursor });
  latest.current = { draft, cursor };
  const sendAfterTranscript = useRef(false);
  const mic = useMic({
    serverId,
    onTranscript: (spoken) => {
      const next = insertDictation(latest.current.draft, latest.current.cursor, spoken);
      setDraft(next.text);
      setCursor(next.cursor);
      setSelection({ start: next.cursor, end: next.cursor });
      if (sendAfterTranscript.current) {
        sendAfterTranscript.current = false;
        void send(next.text);
      }
    },
  });
  const dictating = !!mic && showsDictationOverlay(mic.status, mic.isRecording, mic.isProcessing);
  useEffect(() => {
    if (!dictating) sendAfterTranscript.current = false;
  }, [dictating]);

  const mention: ActiveMention | null = activeMention(draft, cursor);
  const rows = mention && dismissed !== mention.start && !dictating ? pickerRows(mention.query, group, names, members) : [];
  const picking = rows.length > 0;
  const targets = assignTargets(draft, group, names);
  const showAssign = targets.length > 0;
  const hint = composerHint(draft, group, names, { picking, assign: assignOn && showAssign });
  useEffect(() => setHighlight(0), [mention?.query, mention?.start]);

  const change = (text: string) => {
    setDraft(text);
    setSelection(undefined);
    // The cursor follows typing at the end; onSelectionChange corrects it for edits mid-text.
    if (text.length !== draft.length) setCursor((at) => Math.max(0, at + text.length - draft.length));
  };

  const pick = (row: PickerRow) => {
    if (!mention) return;
    const next = insertMention(draft, mention, row.id);
    setDraft(next.text);
    setCursor(next.cursor);
    setSelection({ start: next.cursor, end: next.cursor });
    input.current?.focus();
  };

  const at = () => {
    const before = draft.slice(0, cursor);
    const insert = before && !/\s$/.test(before) ? " @" : "@";
    const text = before + insert + draft.slice(cursor);
    const next = cursor + insert.length;
    setDraft(text);
    setCursor(next);
    setSelection({ start: next, end: next });
    setDismissed(null);
    input.current?.focus();
  };

  const send = async (raw: string = draft) => {
    const out = composerPost(raw, assignOn, group, names);
    if (!out || sending) return;
    setSending(true);
    const ok = await onSend(out.text, { assign: out.assign });
    setSending(false);
    if (ok) {
      setDraft("");
      setCursor(0);
      setSelection(undefined);
      setAssignOn(false);
    }
  };

  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (!web) return;
    const key = e.nativeEvent.key;
    const shift = (e.nativeEvent as { shiftKey?: boolean }).shiftKey;
    if (picking) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h + (key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      if (key === "Enter" || key === "Tab") {
        e.preventDefault();
        pick(rows[Math.min(highlight, rows.length - 1)]!);
        return;
      }
      if (key === "Escape") {
        e.preventDefault();
        setDismissed(mention?.start ?? null);
        return;
      }
    }
    if (key === "Enter" && !shift) {
      e.preventDefault();
      void send();
    }
  };

  const canSend = !!draft.trim() && !sending;
  const sendState = sendButton(draft, sending);
  const swipeDismiss = useSwipeDownDismiss();
  return (
    <View style={{ position: "relative" }} {...swipeDismiss}>
      {/* Floats over the transcript above the box, so the thread does not jump while picking. */}
      {picking ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: "100%", zIndex: 10 }}>
          <PickerCard rows={rows} highlight={highlight} ctx={ctx} onPick={pick} />
        </View>
      ) : null}
      <View
        style={{
          marginHorizontal: 16,
          marginBottom: phone && !keyboardOpen ? 34 : 12,
          backgroundColor: c.surface1,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 16,
          paddingVertical: 8,
          paddingHorizontal: 12,
          overflow: "hidden",
        }}
      >
        <View
          testID="group-composer-hint"
          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border }}
        >
          <Icon name="ArrowRight" size={13} color={c.foregroundMuted} />
          <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>
            <Segments segments={hint} c={c} />
          </Text>
        </View>
        <TextInput
          ref={input as never}
          value={draft}
          onChangeText={change}
          selection={selection}
          onSelectionChange={(e) => {
            setCursor(e.nativeEvent.selection.end);
            if (selection) setSelection(undefined);
          }}
          onKeyPress={onKeyPress}
          multiline
          maxLength={MAX_DRAFT}
          editable={!sending}
          placeholder={`Message ${group.name}`}
          placeholderTextColor={c.foregroundMuted}
          accessibilityLabel={`Message ${group.name}`}
          style={{
            color: c.foreground,
            fontSize: 15,
            lineHeight: 22,
            minHeight: 40,
            maxHeight: 160,
            paddingVertical: 8,
            paddingHorizontal: 0,
            // Web: the box itself is the focus frame (no browser outline inside it).
            ...(web ? { outlineWidth: 0 } : null),
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mention someone"
              onPress={at}
              hitSlop={8}
              style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : 1 })}
            >
              <Icon name="AtSign" size={20} color={c.foregroundMuted} />
            </Pressable>
            {mic ? (
              <Pressable
                testID="group-composer-mic"
                accessibilityRole="button"
                accessibilityLabel="Dictate"
                // Not ready: still tappable, so the app can say why ("model downloading" etc.).
                onPress={() => void mic.start()}
                disabled={sending}
                hitSlop={8}
                style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : mic.ready ? 1 : 0.4 })}
              >
                <Icon name="Mic" size={20} color={c.foregroundMuted} />
              </Pressable>
            ) : null}
            {showAssign ? (
              <Pressable
                testID="group-composer-assign"
                accessibilityRole="switch"
                accessibilityState={{ checked: assignOn }}
                accessibilityLabel={`Assign as a task to ${targets.map((id) => displayName(id, names)).join(", ")}`}
                onPress={() => setAssignOn((on) => !on)}
                hitSlop={6}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingVertical: 4,
                  paddingHorizontal: 10,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: assignOn ? accentFill(c) : c.border,
                  backgroundColor: assignOn ? accentFill(c) : pressed ? c.surface2 : "transparent",
                })}
              >
                <Icon name="CornerUpRight" size={14} color={assignOn ? accentOn(c) : c.foregroundMuted} />
                <Text style={{ color: assignOn ? accentOn(c) : c.foregroundMuted, fontSize: 13, fontWeight: "600" }}>Assign</Text>
              </Pressable>
            ) : null}
          </View>
          {sendState === "hidden" ? null : (
            <Pressable
              testID="group-composer-send"
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={!canSend}
              onPress={() => void send()}
              style={{
                width: SEND_SIZE,
                height: SEND_SIZE,
                borderRadius: SEND_SIZE / 2,
                backgroundColor: accentFill(c),
                alignItems: "center",
                justifyContent: "center",
                marginLeft: SEND_MARGIN_LEFT,
                opacity: canSend ? 1 : SEND_DISABLED_OPACITY,
              }}
            >
              {sendState === "sending" ? (
                <ActivityIndicator size="small" color={accentOn(c)} />
              ) : (
                <Icon name="ArrowUp" size={sendIconSize(web)} color={accentOn(c)} />
              )}
            </Pressable>
          )}
        </View>
        {/* Recording: the app's dictation bar covers the box, as in the agent composer. */}
        {mic && dictating && DICTATION ? (
          <View
            testID="group-composer-dictation"
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.accent, justifyContent: "center" }}
          >
            <DICTATION.DictationOverlay
              volume={mic.volume}
              duration={mic.duration}
              isRecording={mic.isRecording}
              isProcessing={mic.isProcessing}
              status={mic.status}
              errorText={mic.status === "failed" ? (mic.error ?? undefined) : undefined}
              onCancel={() => void mic.cancel()}
              onAccept={() => {
                sendAfterTranscript.current = false;
                void mic.confirm();
              }}
              onAcceptAndSend={() => {
                sendAfterTranscript.current = true;
                void mic.confirm();
              }}
              onRetry={mic.status === "failed" ? () => void mic.retry() : undefined}
              onDiscard={mic.status === "failed" ? mic.discard : undefined}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ---------- members (info sheet, laptop panel) ----------

type EditState = {
  editing: boolean;
  /** A member whose remove is waiting for the second tap. */
  confirm: string | null;
  /** A bot id being saved (its row shows a spinner). */
  saving: string | null;
};

function MemberRows({
  ctx,
  members,
  dense,
  edit,
  onOp,
  onConfirm,
}: {
  ctx: Ctx;
  members: RoomMemberState[];
  dense?: boolean;
  edit?: EditState;
  onOp?(op: MemberOp): void;
  onConfirm?(bot: string | null): void;
}) {
  const { c, group, names } = ctx;
  const byId = new Map(members.map((m) => [m.botId, m]));
  const order = leadsFirst(group);
  const editing = !!edit?.editing;
  return (
    <View>
      {order.map((id) => {
        const state = byId.get(id);
        const busy = memberBusy(state?.state);
        const name = displayName(id, names);
        const blocked = removeBlocked(group, id);
        const isLead = group.leads.includes(id);
        const leadBlocked = leadToggleBlocked(group, id);
        const confirming = editing && edit?.confirm === id;
        const saving = edit?.saving === id;
        const body = (
          <>
            <BotAvatar bot={ctx.avatar(id)} size={dense ? 36 : 40} theme={ctx.theme} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text numberOfLines={1} style={{ color: c.foreground, fontSize: dense ? 14 : 16, fontWeight: "600" }}>
                  {name}
                </Text>
                {isLead ? <LeadTag c={c} /> : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                <View
                  style={{
                    width: busy ? 10 : 8,
                    height: busy ? 10 : 8,
                    borderRadius: 5,
                    backgroundColor: busy ? "transparent" : c.foregroundMuted,
                    borderWidth: busy ? 1.5 : 0,
                    borderColor: c.foregroundMuted,
                    opacity: busy ? 1 : 0.7,
                  }}
                />
                <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: dense ? 12 : 13 }}>
                  {editing && isLead && !dense ? "Lead: hears every message" : memberStatus(state)}
                </Text>
              </View>
            </View>
          </>
        );
        const rowStyle = {
          minHeight: dense ? 48 : 60,
          flexDirection: "row" as const,
          alignItems: "center" as const,
          gap: 12,
          paddingVertical: 8,
          paddingHorizontal: 16,
        };
        if (!editing) {
          return (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={`${name}${isLead ? ", lead" : ""}, ${memberStatus(state)}. Open main chat`}
              onPress={() => ctx.openMain(id)}
              style={({ pressed }) => ({ ...rowStyle, backgroundColor: pressed ? c.surface2 : "transparent" })}
            >
              {body}
              <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />
            </Pressable>
          );
        }
        return (
          <View key={id} testID={`group-member-${id}`} style={rowStyle}>
            {body}
            {saving ? (
              <ActivityIndicator size="small" color={c.foregroundMuted} />
            ) : confirming ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => onConfirm?.(null)} hitSlop={6} style={{ padding: 4 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${name} from ${group.name}`}
                  onPress={() => onOp?.({ kind: "remove", bot: id })}
                  style={({ pressed }) => ({
                    paddingVertical: 6,
                    paddingHorizontal: 10,
                    borderRadius: 8,
                    backgroundColor: c.statusDanger,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "600" }}>Remove</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Pressable
                  testID={`group-lead-${id}`}
                  accessibilityRole="switch"
                  accessibilityLabel={leadBlocked ? `${name} is the only lead: ${leadBlocked}` : `${name} is a lead`}
                  accessibilityState={{ checked: isLead, disabled: !!leadBlocked }}
                  onPress={() => onOp?.({ kind: "lead", bot: id })}
                  hitSlop={4}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingVertical: 5,
                    paddingHorizontal: 8,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: isLead ? accentText(c) : c.border,
                    backgroundColor: isLead ? c.surface2 : "transparent",
                    opacity: leadBlocked ? 0.5 : pressed ? 0.6 : 1,
                  })}
                >
                  <Icon name="Crown" size={14} color={isLead ? accentText(c) : c.foregroundMuted} />
                  <Text style={{ color: isLead ? accentText(c) : c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Lead</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={blocked ? `Cannot remove ${name}: ${blocked}` : `Remove ${name}`}
                  accessibilityState={{ disabled: !!blocked }}
                  onPress={() => (blocked ? onOp?.({ kind: "remove", bot: id }) : onConfirm?.(id))}
                  hitSlop={4}
                  style={({ pressed }) => ({ padding: 8, opacity: blocked ? 0.3 : pressed ? 0.6 : 1 })}
                >
                  <Icon name="CircleMinus" size={20} color={blocked ? c.foregroundMuted : c.statusDanger} />
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** Bots on the host that are not in the group, each with an add button (edit mode only). */
function AddMemberRows({ ctx, edit, onOp, dense }: { ctx: Ctx; edit: EditState; onOp(op: MemberOp): void; dense?: boolean }) {
  const { c, group } = ctx;
  const candidates = addableBots(group, ctx.bots);
  if (group.members.length >= MAX_MEMBERS) {
    return <Text style={{ color: c.foregroundMuted, fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 }}>The group is full ({MAX_MEMBERS} bots).</Text>;
  }
  if (!candidates.length) {
    return <Text style={{ color: c.foregroundMuted, fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 }}>Every bot is already in this group.</Text>;
  }
  return (
    <View>
      {candidates.map((bot) => (
        <Pressable
          key={bot.id}
          testID={`group-add-${bot.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Add ${bot.name} to ${group.name}`}
          disabled={!!edit.saving}
          onPress={() => onOp({ kind: "add", bot: bot.id })}
          style={({ pressed }) => ({
            minHeight: dense ? 44 : 52,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 6,
            paddingHorizontal: 16,
            backgroundColor: pressed ? c.surface2 : "transparent",
          })}
        >
          <BotAvatar bot={ctx.avatar(bot.id)} size={dense ? 28 : 32} theme={ctx.theme} />
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: dense ? 14 : 15 }}>
            {bot.name}
          </Text>
          {edit.saving === bot.id ? (
            <ActivityIndicator size="small" color={c.foregroundMuted} />
          ) : (
            <Icon name="CirclePlus" size={20} color={accentText(c)} />
          )}
        </Pressable>
      ))}
    </View>
  );
}

/** Members list with an Edit / Done switch: add (bots not in the group), remove, toggle lead (at least one). */
function MembersSection({ ctx, members, dense, title = "Members" }: { ctx: Ctx; members: RoomMemberState[]; dense?: boolean; title?: string }) {
  const { c, group, names } = ctx;
  const toast = useToast();
  const setMembers = useSetMembers(group.id);
  const [edit, setEdit] = useState<EditState>({ editing: false, confirm: null, saving: null });
  const run = (op: MemberOp) => {
    const next = applyMemberOp(group, op);
    if ("error" in next) {
      toast.show(next.error, { variant: "warning" });
      return;
    }
    setEdit((e) => ({ ...e, confirm: null, saving: op.bot }));
    setMembers(next.members, next.leads)
      .then(() => {
        const name = displayName(op.bot, names);
        const leadText = next.leads.includes(op.bot) ? `${name} is now a lead` : `${name} is no longer a lead`;
        toast.show(op.kind === "add" ? `${name} added` : op.kind === "remove" ? `${name} removed` : leadText);
      })
      .catch((cause: unknown) => toast.error(`Not saved: ${errorText(cause)}`))
      .finally(() => setEdit((e) => ({ ...e, saving: null })));
  };
  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", paddingRight: 8 }}>
        <View style={{ flex: 1 }}>{title ? <SectionLabel c={c}>{title}</SectionLabel> : null}</View>
        <Pressable
          testID="group-members-edit"
          accessibilityRole="button"
          accessibilityLabel={edit.editing ? "Done editing members" : "Edit members"}
          onPress={() => setEdit((e) => ({ editing: !e.editing, confirm: null, saving: e.saving }))}
          hitSlop={8}
          style={({ pressed }) => ({ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 2, opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={{ color: accentText(c), fontSize: 14, fontWeight: "600" }}>{edit.editing ? "Done" : "Edit"}</Text>
        </Pressable>
      </View>
      <MemberRows
        ctx={ctx}
        members={members}
        dense={dense}
        edit={edit}
        onOp={run}
        onConfirm={(bot) => setEdit((e) => ({ ...e, confirm: bot }))}
      />
      {edit.editing ? (
        <>
          <SectionLabel c={c}>Add a member</SectionLabel>
          <AddMemberRows ctx={ctx} edit={edit} onOp={run} dense={dense} />
        </>
      ) : null}
    </View>
  );
}

function RoomRow({ icon, label, value, c, onPress }: { icon: string; label: string; value: string; c: Colors; onPress?: () => void }) {
  const body = (
    <>
      <Icon name={icon} size={18} color={c.foregroundMuted} />
      <Text style={{ flex: 1, color: c.foreground, fontSize: 15 }}>{label}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>{value}</Text>
      {onPress ? <Icon name="ChevronRight" size={14} color={c.foregroundMuted} /> : null}
    </>
  );
  const style = { minHeight: 44, flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 16 };
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ ...style, opacity: pressed ? 0.6 : 1 })}>
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}

function SectionLabel({ children, c }: { children: ReactNode; c: Colors }) {
  return <Text style={{ color: c.foregroundMuted, fontSize: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>{children}</Text>;
}

function InfoSheet({ ctx, members, open, onOpenChange }: { ctx: Ctx; members: RoomMemberState[]; open: boolean; onOpenChange(open: boolean): void }) {
  const { c, group, names } = ctx;
  const stack = avatarStack(group).map(ctx.avatar);
  return (
    <Modal title="Group info" open={open} onOpenChange={onOpenChange}>
      <Modal.Content contentContainerStyle={{ paddingHorizontal: 0, paddingTop: 8, paddingBottom: 24, gap: 0 }}>
        <View style={{ alignItems: "center", paddingBottom: 12 }}>
          <GroupAvatar stack={stack} size={56} theme={ctx.theme} />
          <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "700", marginTop: 10 }}>{group.name}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 13, marginTop: 2 }}>{groupSubtitle(group, names)}</Text>
        </View>
        <MembersSection ctx={ctx} members={members} />
        <View style={{ height: 1, backgroundColor: c.border, marginVertical: 8 }} />
        <SectionLabel c={c}>Room</SectionLabel>
        <RoomRow
          icon="Crown"
          label={group.leads.length === 1 ? "Lead" : "Leads"}
          value={leadsFirst(group).filter((id) => group.leads.includes(id)).map((id) => displayName(id, names)).join(", ")}
          c={c}
          onPress={
            group.leads.length === 1
              ? () => {
                  onOpenChange(false);
                  ctx.openMain(group.leads[0]!);
                }
              : undefined
          }
        />
        <RoomRow icon="MessageSquareText" label="Room talk into main memory" value="not yet" c={c} />
      </Modal.Content>
    </Modal>
  );
}

function RoutingSummary({ ctx }: { ctx: Ctx }) {
  const { c, group, names } = ctx;
  const lines = [
    `Every message → ${leadsLabel(group, names)}, who may stay silent`,
    "@name → that bot too · @all → everyone",
    "@name task: or Assign → that bot's main chat",
    `${group.leads.length === 1 ? "The lead" : "Leads"} can assign tasks too, ${LEAD_ASSIGN_CAP} per 10 min${group.leads.length === 1 ? "" : " in all"}`,
    `Bots wake each other up to ${HOP_CAP} hops`,
  ];
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, marginBottom: 6 }}>Routing</Text>
      {lines.map((line) => (
        <Text key={line} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function MembersPanel({ ctx, members }: { ctx: Ctx; members: RoomMemberState[] }) {
  const { c } = ctx;
  return (
    <View testID="group-members-panel" style={{ width: PANEL_WIDTH, borderLeftWidth: 1, borderLeftColor: c.border, backgroundColor: c.surface0 }}>
      <View style={{ height: 48, justifyContent: "center", paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>Members</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
        <MembersSection ctx={ctx} members={members} dense title="" />
        <View style={{ height: 1, backgroundColor: c.border, marginTop: 4 }} />
        <RoutingSummary ctx={ctx} />
      </ScrollView>
    </View>
  );
}

// ---------- the screen ----------

/** Slim bar under the app's ScreenHeader: avatars, who is in the group, and the info / panel button. */
function GroupBar({ ctx, wide, panelOpen, onButton }: { ctx: Ctx; wide: boolean; panelOpen: boolean; onButton(): void }) {
  const { c, group, names } = ctx;
  const lead = leadsFirst(group).map(ctx.avatar);
  return (
    <View
      style={{
        height: wide ? 48 : 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingLeft: 16,
        paddingRight: 8,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <AvatarRow bots={lead.slice(0, 4)} size={wide ? 22 : 24} step={15} theme={ctx.theme} />
      <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}>
        {memberLine(group, names)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={wide ? (panelOpen ? "Hide members" : "Show members") : "Group info"}
        testID="group-info-button"
        onPress={onButton}
        style={({ pressed }) => ({
          width: 40,
          height: 36,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed || (wide && panelOpen) ? c.surface2 : "transparent",
        })}
      >
        <Icon name={wide ? "PanelRight" : "Users"} size={18} color={c.foreground} />
      </Pressable>
    </View>
  );
}

/** Re-reads the clock once a minute (the quiet line); nothing is fetched. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// `floatingHeaderInset`: set by Paseo builds that draw header D for this screen (see group-header).
export function GroupScreen({
  theme,
  params,
  navigation,
  layout,
  host,
  floatingHeaderInset,
}: PluginScreenProps & { floatingHeaderInset?: number }) {
  const c = theme.colors;
  const groupId = params.groupId ?? "";
  const { groups, isLoading: listLoading, error: listError } = useRoomsList();
  const { bots } = useBotsData();
  const summary = groups.find((g) => g.id === groupId);
  const toast = useToast();
  const post = usePostToRoom(groupId);
  const thread = useRoomThread(groupId);
  const { markSeen } = useRoomsSeen();
  const openMain = useOpenMain(navigation, bots);
  const now = useMinute();
  const wide = !layout.compact;
  const keyboard = useKeyboardInset();
  const [infoOpen, setInfoOpen] = useState(false);
  // Header D: the app's header has the avatars, name and people button, so no GroupBar.
  const headerD = floatingHeaderInset !== undefined;
  useGroupInfoRequests(groupId, setInfoOpen);
  const [panelOpen, setPanelOpen] = useState(true);
  const [pending, setPending] = useState<PendingPost | null>(null);

  const group = useMemo(() => (summary ? toGroup(summary) : null), [summary]);
  const names = useMemo(() => namesFor(summary, bots), [summary, bots]);
  const newest = thread.messages[thread.messages.length - 1]?.ts ?? summary?.lastTs ?? null;
  useEffect(() => markSeen(groupId, newest), [groupId, newest, markSeen]);
  // The sent message has arrived in the thread: drop the optimistic copy (by id, or by text before
  // rooms.post answers: the host shows the message before it has woken the leads; group-pending.ts).
  const arrived = pendingArrived(pending, thread.messages);
  useEffect(() => {
    if (arrived) setPending(null);
  }, [arrived]);

  if (!group) {
    return (
      <View style={{ flex: 1, backgroundColor: c.surface0, padding: 24, paddingTop: 24 + (floatingHeaderInset ?? 0) }}>
        {listLoading ? (
          <ActivityIndicator color={c.foregroundMuted} />
        ) : (
          <Text style={{ color: listError ? c.statusDanger : c.foregroundMuted }}>
            {listError ? `Groups are not available on this host (${errorText(listError)}).` : `No group "${groupId}".`}
          </Text>
        )}
      </View>
    );
  }

  const ctx: Ctx = {
    theme,
    c,
    group,
    summary,
    names,
    bots,
    avatar: (botId) => avatarFor(botId, summary, bots),
    openMain,
  };

  const send = async (text: string, opts: { assign: boolean } = { assign: false }): Promise<boolean> => {
    const hint = composerHint(text, group, names, { assign: opts.assign });
    const delivery = hint[1]?.text ?? "";
    setPending(startPending(text, `Sending to ${delivery}…`, thread.messages));
    try {
      const result = await post(text, { assign: opts.assign });
      setPending((p) => (p ? { ...p, id: result.id } : p));
      const refused = result.refused.filter((r) => r.reason !== "self");
      if (refused.length) {
        toast.show(`Not passed to ${refused.map((r) => displayName(r.bot, names)).join(", ")}`, { variant: "warning" });
      }
      return true;
    } catch (cause) {
      setPending(null);
      toast.error(`Not sent: ${errorText(cause)}`);
      return false;
    }
  };

  // Centred horizontally in its own column box: alignSelf on the column itself would centre it on
  // the row's cross axis (vertically) and stop it filling the height.
  const column = (
    <View style={{ flex: 1, alignItems: "center" }}>
    <View style={{ flex: 1, width: "100%", maxWidth: wide ? THREAD_MAX : undefined }}>
      <Transcript
        ctx={ctx}
        messages={thread.messages}
        members={thread.members}
        pending={arrived ? null : pending}
        isLoading={thread.isLoading}
        error={thread.error}
        now={now}
        headerInset={floatingHeaderInset}
      />
      <TypingLine ctx={ctx} members={thread.members} />
      <Composer
        ctx={ctx}
        members={thread.members}
        serverId={host.id}
        phone={layout.compact && layout.platform !== "web"}
        web={layout.platform === "web"}
        keyboardOpen={keyboard.inset > 0}
        onSend={send}
      />
    </View>
    </View>
  );

  return (
    <View
      testID="group-screen"
      ref={keyboard.ref as never}
      onLayout={keyboard.onLayout}
      style={{ flex: 1, backgroundColor: c.surface0, paddingBottom: keyboard.inset }}
    >
      {headerD ? null : <GroupBar ctx={ctx} wide={wide} panelOpen={panelOpen} onButton={() => (wide ? setPanelOpen((v) => !v) : setInfoOpen(true))} />}
      <View style={{ flex: 1, flexDirection: "row" }}>
        {column}
        {wide && panelOpen ? <MembersPanel ctx={ctx} members={thread.members} /> : null}
      </View>
      {!wide ? <InfoSheet ctx={ctx} members={thread.members} open={infoOpen} onOpenChange={setInfoOpen} /> : null}
    </View>
  );
}

