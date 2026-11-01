/**
 * Header D for the group screen (13 Oct: "i want the header and swipe animation implemented
 * for group chats"). Paseo builds with the `mobileFloatingHeader` screen option draw the bot chat's
 * floating glass header on phones: back · [members' avatars + group name] ······ [people button].
 * These are the plugin's two parts of it; the app draws the glass, the fade and the title.
 * Older apps ignore the option and keep the plain header, and the screen keeps its own bar then.
 */
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { useBotsData } from "./bot-data";
import { GroupAvatar } from "./group-avatar";
import { avatarFor, toGroup, useRoomsList } from "./group-data";
import { avatarStack } from "./group-format";

/** The people button lives in the app's header, the info sheet in the screen: this links them. */
const infoListeners = new Set<(groupId: string) => void>();

export function requestGroupInfo(groupId: string): void {
  for (const listener of infoListeners) listener(groupId);
}

/** Opens the screen's info sheet when the header's people button asks for this group. */
export function useGroupInfoRequests(groupId: string, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    const listener = (requested: string) => {
      if (requested === groupId) setOpen(true);
    };
    infoListeners.add(listener);
    return () => {
      infoListeners.delete(listener);
    };
  }, [groupId, setOpen]);
}

/** The bot chat's header avatar is 28 pt; the group's stack fits the same square. */
const AVATAR = 28;

/** The members' avatars stacked as on the home row (plain, no circle), the lead in front. */
export function GroupHeaderAvatar({ theme, params }: PluginScreenProps) {
  const groupId = params.groupId ?? "";
  const { groups } = useRoomsList();
  const { bots } = useBotsData();
  const summary = groups.find((g) => g.id === groupId);
  if (!summary) return null;
  const stack = avatarStack(toGroup(summary)).map((id) => avatarFor(id, summary, bots));
  return (
    <View testID="group-header-avatar">
      <GroupAvatar stack={stack} size={AVATAR} theme={theme} />
    </View>
  );
}

/** The people button (40 x 36 in the glass pill): opens Group info. */
export function GroupHeaderControls({ theme, params }: PluginScreenProps) {
  const groupId = params.groupId ?? "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Group info"
      testID="group-info-button"
      onPress={() => requestGroupInfo(groupId)}
      style={({ pressed }) => ({
        width: 40,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name="Users" size={18} color={theme.colors.foreground} />
    </Pressable>
  );
}
