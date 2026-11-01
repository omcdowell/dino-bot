/**
 * Bot avatar image (device-cached by content hash, client/avatar-cache.ts), with the bot's Lucide
 * icon on a rounded tile as the fallback. Shared by the phone home and the group screen.
 *
 * Asks only for the PNG size the slot needs (64/128/512); draws from avatar.json (composed SVG)
 * when an SVG drawer is registered (client/avatar-svg.ts: the app's SvgXml, registered at start by
 * index.client.tsx, feature-detected) and this session's pack covers the bot's.
 *
 * AV3: right after a Save in the avatar designer (and while it waits offline in the outbox), the
 * device draws the saved avatar.json itself with the bundled pack, until the host's PNG catches up
 * (client/avatar-outbox.ts optimisticAvatar).
 */
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Image, PixelRatio, View } from "react-native";
import { botsAvatarRpc } from "../shared/home-rpc";
import { avatarPngSize, avatarQueryOptions, pruneAvatars, type AvatarBot } from "./avatar-cache";
import { sessionPack } from "./avatar-pack-store";
import { avatarSvg } from "./avatar-svg";
import { AVATAR_PACK, canonicalAvatarJson, composeAvatarSvg } from "../shared/avatar";
import { optimisticAvatar } from "./avatar-outbox";
import { useBotAvatarEntry } from "./avatar-outbox-data";

export type AvatarSource = AvatarBot & { icon: string };

export function BotAvatar({ bot, size, theme, round = false }: { bot: AvatarSource; size: number; theme: PluginTheme; round?: boolean }) {
  const getAvatar = useRpc(botsAvatarRpc);
  const queryClient = useQueryClient();
  const Svg = avatarSvg();
  const need = { size: avatarPngSize(size, PixelRatio.get()), pack: Svg ? sessionPack(queryClient) : null };
  const { data, isPlaceholderData, isSuccess } = useQuery(avatarQueryOptions(queryClient, bot, getAvatar, need));
  // A new avatar version has loaded: drop this bot's older copies from the device cache.
  const loaded = isSuccess && !isPlaceholderData;
  useEffect(() => {
    if (loaded && bot.avatarHash) pruneAvatars(queryClient, bot);
  }, [loaded, bot.id, bot.avatarHash, queryClient]);
  const local = optimisticAvatar(useBotAvatarEntry(bot.id), bot.avatarHash);
  const localKey = local ? canonicalAvatarJson(local) : null;
  const localXml = useMemo(() => {
    if (!local || !Svg) return null;
    try {
      return composeAvatarSvg(local, AVATAR_PACK);
    } catch {
      return null;
    }
  }, [localKey, Svg]);
  if (localXml && Svg) return <Svg xml={localXml} width={size} height={size} />;
  if (data?.svg && Svg) {
    return <Svg xml={data.svg} width={size} height={size} />;
  }
  if (data?.dataUri) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: data.dataUri }}
        style={{ width: size, height: size }}
        resizeMode="contain"
      />
    );
  }
  // Placeholder until the real Cadu icons land: today's Lucide icon on a rounded tile.
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: round ? size / 2 : size * 0.3,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={bot.icon} size={Math.round(size * 0.48)} color={theme.colors.foreground} />
    </View>
  );
}
