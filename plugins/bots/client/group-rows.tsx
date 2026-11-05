/**
 * Group rows outside the group screen. They sit in the same list as the bot rows on the phone home
 * and in the Bots sidebar, ordered by recency with them (`mingle` in home-format.ts; 13 Oct).
 * No rows when the host has no groups (or no rooms RPCs).
 */
import type { PluginScreenLocation } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useRef, type ComponentType, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { RoomSummary } from "./group-types";
import type { Bot } from "../shared/rpc";
import { GroupAvatar } from "./group-avatar";
import type { AvatarSource } from "./bot-avatar";
import { avatarFor, isUnread, toGroup, useRoomHead, useRoomsSeen } from "./group-data";
import { avatarStack, splitPreview } from "./group-format";
import { GROUP_SCREEN_ID, openGroupScreen } from "./group-nav";
import { rowTime } from "./home-format";
import { HOLD_DELAY_MS, measure, type OnHold, type Variant } from "./hold-overlay";
import { accentText } from "./accent";


/** Unread dot, or the hollow working ring while a member is woken in the room. */
function GroupTrail({ woken, unread, theme, small }: { woken: boolean; unread: boolean; theme: PluginTheme; small?: boolean }) {
  const c = theme.colors;
  if (woken) {
    const d = small ? 8 : 12;
    return (
      <View
        accessibilityLabel="Working"
        style={{ width: d, height: d, borderRadius: d / 2, borderWidth: 1.5, borderColor: c.foregroundMuted, marginLeft: small ? 0 : 10 }}
      />
    );
  }
  if (unread) {
    const d = small ? 8 : 10;
    return <View accessibilityLabel="Unread" style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: accentText(c), marginLeft: small ? 0 : 10 }} />;
  }
  return null;
}

/** Phone home row for a group: stacked member avatars (no disc), name, time, "Wallace: …". */
export function GroupHomeRow({
  group,
  bots,
  now,
  theme,
  onError,
  onHold,
  variant = "list",
}: {
  group: RoomSummary;
  bots: readonly Bot[];
  now: number;
  theme: PluginTheme;
  onError(message: string): void;
  onHold?: OnHold;
  variant?: Variant;
}) {
  const c = theme.colors;
  const ref = useRef<View>(null);
  const held = variant === "held";
  const { seen } = useRoomsSeen();
  const { woken } = useRoomHead(group.id);
  const onOpen = (g: RoomSummary) => {
    if (!openGroupScreen(g)) onError("This Paseo app cannot open the group screen. Update the app.");
  };
  const unread = isUnread(group, seen);
  const { sender, rest } = splitPreview(group.lastPreview);
  const stack = avatarStack(toGroup(group)).map((id) => avatarFor(id, group, bots));
  const lineColor = unread ? c.foreground : c.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${group.name} group${group.lastPreview ? `. ${group.lastPreview}` : ""}${unread ? ", unread" : ""}`}
      testID={held ? `bots-held-group-${group.id}` : `bots-home-group-${group.id}`}
      ref={ref}
      onPress={() => onOpen(group)}
      onLongPress={onHold ? () => measure(ref.current, onHold) : undefined}
      delayLongPress={HOLD_DELAY_MS}
      disabled={held}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: held ? 14 : 16,
        paddingVertical: 12,
        minHeight: held ? undefined : 88,
        flex: held ? 1 : undefined,
        backgroundColor: pressed && !held ? c.surface1 : "transparent",
      })}
    >
      <GroupAvatar stack={stack} size={56} theme={theme} />
      <View style={{ flex: 1, marginLeft: 14, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline" }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 17, fontWeight: "700", color: c.foreground }}>
            {group.name}
          </Text>
          <Text style={{ fontSize: 14, marginLeft: 8, color: unread ? accentText(c) : c.foregroundMuted }}>
            {rowTime(group.lastTs, new Date(now))}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, color: lineColor }}>
            {sender ? <Text style={{ fontWeight: "600", color: lineColor }}>{`${sender}: `}</Text> : null}
            {group.lastPreview ? rest : "No messages yet"}
          </Text>
          <GroupTrail woken={woken} unread={unread} theme={theme} />
        </View>
      </View>
    </Pressable>
  );
}

/** A pinned group chat on the phone home: stacked avatars, name cut with "…", unread dot. */
export function GroupPinnedTile({
  group,
  bots,
  theme,
  size,
  width,
  labelWidth,
  onError,
  onHold,
  variant = "list",
}: {
  group: RoomSummary;
  bots: readonly Bot[];
  theme: PluginTheme;
  size: number;
  width: number;
  /** List variant: the name's own width, may be wider than the tile (centred over it). */
  labelWidth?: number;
  onError(message: string): void;
  onHold?: OnHold;
  variant?: Variant;
}) {
  const c = theme.colors;
  const ref = useRef<View>(null);
  const held = variant === "held";
  const { seen } = useRoomsSeen();
  const { woken } = useRoomHead(group.id);
  const unread = isUnread(group, seen);
  const stack = avatarStack(toGroup(group)).map((id) => avatarFor(id, group, bots));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${group.name} group${unread ? ", unread" : ""}`}
      testID={held ? `bots-held-pinned-group-${group.id}` : `bots-home-pinned-group-${group.id}`}
      ref={ref}
      onPress={() => {
        if (!openGroupScreen(group)) onError("This Paseo app cannot open the group screen. Update the app.");
      }}
      onLongPress={onHold ? () => measure(ref.current, onHold) : undefined}
      delayLongPress={HOLD_DELAY_MS}
      disabled={held}
      style={({ pressed }) => ({
        width,
        alignItems: "center",
        paddingTop: held ? 0 : 8,
        paddingBottom: held ? 0 : 20,
        opacity: pressed && !held ? 0.6 : 1,
      })}
    >
      <GroupAvatar stack={stack} size={size} theme={theme} />
      <View
        style={{
          marginTop: held ? 10 : 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          ...(!held && labelWidth !== undefined ? { width: labelWidth } : { maxWidth: width - 4 }),
        }}
      >
        <Text numberOfLines={held ? 2 : 1} ellipsizeMode="tail" style={{ fontSize: 17, color: c.foregroundMuted, textAlign: "center", flexShrink: 1 }}>
          {group.name}
        </Text>
        <GroupTrail woken={woken} unread={unread} theme={theme} small />
      </View>
    </Pressable>
  );
}

/**
 * Sidebar row icon: the members' stacked avatars at the row's icon size. `SidebarRow` takes a
 * component for `icon` and keeps it by identity, so one component per member set is cached.
 */
const sidebarIcons = new Map<string, ComponentType<{ size: number; color: string }>>();
function sidebarIcon(stack: AvatarSource[], theme: PluginTheme): ComponentType<{ size: number; color: string }> {
  const key = `${theme.colors.surface2}|${stack.map((b) => `${b.id}:${b.avatarHash ?? ""}:${b.icon}`).join(",")}`;
  let icon = sidebarIcons.get(key);
  if (!icon) {
    // The row's icon slot is ~16 pt; the stack draws a little larger so the faces stay readable.
    const Stacked = ({ size }: { size: number; color: string }) => {
      const box = Math.round(size * 1.5);
      return (
        <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", overflow: "visible" }}>
          <GroupAvatar stack={stack} size={box} theme={theme} />
        </View>
      );
    };
    icon = Stacked;
    sidebarIcons.set(key, icon);
  }
  return icon;
}

export function GroupSidebarRow({
  group,
  bots,
  active,
  theme,
  trailingTime,
  onOpen,
}: {
  group: RoomSummary;
  bots: readonly Bot[];
  active: boolean;
  theme: PluginTheme;
  trailingTime: ReactNode;
  onOpen(): void;
}) {
  const { woken } = useRoomHead(group.id);
  const { seen } = useRoomsSeen();
  const unread = isUnread(group, seen);
  const stack = avatarStack(toGroup(group)).map((id) => avatarFor(id, group, bots));
  return (
    <SidebarRow
      id={`group-${group.id}`}
      icon={sidebarIcon(stack, theme)}
      label={group.name}
      active={active}
      onPress={onOpen}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <GroupTrail woken={woken} unread={unread && !active} theme={theme} small />
          {trailingTime}
        </View>
      }
    />
  );
}

/** The sidebar's open group, if the current screen is one. */
export function openGroupId(currentScreen: PluginScreenLocation | null): string | undefined {
  return currentScreen?.screenId === GROUP_SCREEN_ID ? currentScreen.params.groupId : undefined;
}
