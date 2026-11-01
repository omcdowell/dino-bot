/**
 * Group avatars, as the app shows a bot's avatar: the plain line-art image, no disc or ring
 * (13 Oct: "match the current avatar look with no circle, just stack them over each
 * other"). The lead is always drawn last, so it sits in front.
 * - `GroupAvatar`: a square (home row, info sheet, sidebar icon): two members behind at the top,
 *   the lead larger, lower and in front. Scales with `size` (designed at 56).
 * - `AvatarRow`: avatars in a row overlapping at a fixed step (group header bar), the lead first
 *   (leftmost) and in front.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { View } from "react-native";
import { BotAvatar, type AvatarSource } from "./bot-avatar";

/** Places in a 56 pt square for the members behind the lead (1 or 2 of them). */
export function stackSpots(behind: number, size: number): { left: number; top: number; size: number }[] {
  const k = size / 56;
  const s = Math.round(34 * k);
  if (behind <= 0) return [];
  if (behind === 1) return [{ left: Math.round(22 * k), top: 0, size: s }];
  return [
    { left: 0, top: 0, size: s },
    { left: Math.round(22 * k), top: 0, size: s },
  ];
}

/** The lead's place in the square: larger, lower, in front. A lone member fills the square. */
export function leadSpot(behind: number, size: number): { left: number; top: number; size: number } {
  const k = size / 56;
  if (behind <= 0) return { left: 0, top: 0, size };
  const s = Math.round(38 * k);
  return { left: Math.round(9 * k), top: size - s, size: s };
}

/** `stack`: member avatars, the lead last (`avatarStack`). Up to two shown behind the lead. */
export function GroupAvatar({ stack, size, theme }: { stack: AvatarSource[]; size: number; theme: PluginTheme }) {
  const lead = stack[stack.length - 1];
  const behind = stack.slice(0, -1).slice(-2);
  if (!lead) return <View style={{ width: size, height: size }} />;
  const spots = stackSpots(behind.length, size);
  const front = leadSpot(behind.length, size);
  return (
    <View style={{ width: size, height: size }}>
      {behind.map((bot, i) => (
        <View key={bot.id} style={{ position: "absolute", left: spots[i]!.left, top: spots[i]!.top }}>
          <BotAvatar bot={bot} size={spots[i]!.size} theme={theme} />
        </View>
      ))}
      <View style={{ position: "absolute", left: front.left, top: front.top }}>
        <BotAvatar bot={lead} size={front.size} theme={theme} />
      </View>
    </View>
  );
}

/** Overlapping row: `bots[0]` (the lead) leftmost and in front. */
export function AvatarRow({ bots, size, step, theme }: { bots: AvatarSource[]; size: number; step: number; theme: PluginTheme }) {
  return (
    <View style={{ width: size + step * Math.max(0, bots.length - 1), height: size }}>
      {bots.map((bot, i) => (
        <View key={bot.id} style={{ position: "absolute", left: i * step, zIndex: bots.length - i }}>
          <BotAvatar bot={bot} size={size} theme={theme} />
        </View>
      ))}
    </View>
  );
}
