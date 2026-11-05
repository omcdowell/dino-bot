import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { botsNewChatRpc, botsOpenRpc } from "../shared/rpc";
import { BOTS_QUERY_KEY } from "./sidebar";
import { claimTapJump } from "./tap-jump";
import { openChatPatiently, startingLabel } from "./bot-open";
import { accentFill, accentOn } from "./accent";

type Phase = { kind: "idle" } | { kind: "busy"; label: string } | { kind: "error"; message: string };

export function BotScreen({ theme, params, navigation, layout }: PluginScreenProps) {
  const { botId, agentId, nonce } = params;
  const name = params.name ?? botId ?? "Bot";
  const openChat = useRpc(botsOpenRpc);
  const newChat = useRpc(botsNewChatRpc);
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const started = useRef(false);

  const go = async (action: "open" | "new") => {
    if (!botId) return;
    if (!navigation) {
      setPhase({ kind: "error", message: "This Paseo app is too old to open chats from plugins. Update the app." });
      return;
    }
    setPhase({ kind: "busy", label: action === "new" ? "Starting a fresh chat…" : `Opening ${name}…` });
    try {
      const result =
        action === "new"
          ? await newChat({ botId })
          : await openChatPatiently(() => openChat({ botId }), { onStarting: () => setPhase({ kind: "busy", label: startingLabel(name) }) });
      if (action === "new" || ("created" in result && result.created)) {
        void queryClient.invalidateQueries({ queryKey: BOTS_QUERY_KEY });
      }
      setPhase({ kind: "idle" });
      navigation.openAgent({ agentId: result.agentId });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  useEffect(() => {
    if (started.current || !claimTapJump(nonce)) return;
    started.current = true;
    if (agentId && navigation) navigation.openAgent({ agentId });
    else void go("open");
    // Runs once per tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const c = theme.colors;
  const button = (label: string, onPress: () => void, primary: boolean) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={phase.kind === "busy"}
      style={({ pressed }) => ({
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 10,
        marginTop: 12,
        alignItems: "center",
        backgroundColor: primary ? accentFill(c) : c.surface2,
        opacity: pressed || phase.kind === "busy" ? 0.6 : 1,
      })}
    >
      <Text style={{ color: primary ? accentOn(c) : c.foreground, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0, padding: layout.compact ? 20 : 32, justifyContent: "center" }}>
      <View style={{ maxWidth: 420, width: "100%", alignSelf: "center" }}>
        <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "700" }}>{name}</Text>
        <Text style={{ color: c.foregroundMuted, marginTop: 6 }}>
          Memory lives with the bot, not the chat. A fresh chat starts a clean context and keeps everything it remembers.
        </Text>
        {phase.kind === "busy" ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 20 }}>
            <ActivityIndicator color={c.foregroundMuted} />
            <Text style={{ color: c.foregroundMuted, marginLeft: 10 }}>{phase.label}</Text>
          </View>
        ) : null}
        {phase.kind === "error" ? (
          <Text style={{ color: c.statusDanger, marginTop: 16 }}>{phase.message}</Text>
        ) : null}
        {button("Open chat", () => void go("open"), true)}
        {button("New chat", () => void go("new"), false)}
      </View>
    </View>
  );
}
