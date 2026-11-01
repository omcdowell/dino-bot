import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { Copy } from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { APP_DISPLAY_NAME, APP_LINK_SCHEME } from "@/constants/flavour";
import { providerAddCommand, providerInviteFromIncoming } from "@/hosts/pair-deep-link";
import { setupColumnStyle } from "@/constants/layout";
import { isNative } from "@/constants/platform";

/**
 * A provider invite link opened on the phone or the desktop app (`<scheme>://provider/add?…`, e.g. a private provider package
 * invite the owner sends). Providers are installed on the computer, where the bots run, so this
 * screen says what the link is and copies the one command to paste into the computer's
 * Terminal. The link's access key is never shown, sent or stored by the app.
 */
export default function ProviderLinkScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ link?: string }>();
  const link = typeof params.link === "string" ? params.link : "";
  const invite = useMemo(() => providerInviteFromIncoming(link, APP_LINK_SCHEME), [link]);
  const command = invite ? providerAddCommand(invite, APP_LINK_SCHEME) : "";
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
  }, [command]);
  const handleCopy = useCallback(() => void copy(), [copy]);
  const handleBack = useCallback(() => router.replace("/" as Href), [router]);
  const bodyStyle = useMemo(
    () => [styles.body, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );

  return (
    <View style={styles.container} testID="provider-link-screen">
      <BackHeader title="Add a model provider" onBack={handleBack} />
      <View style={bodyStyle}>
        {invite ? (
          <>
            <View style={styles.card}>
              <Text style={styles.title}>{invite.name ?? "Model provider"}</Text>
              <Text style={styles.muted} selectable>
                {invite.source}
              </Text>
            </View>
            <Text style={styles.text}>
              {`This adds a model provider to ${APP_DISPLAY_NAME} on your computer, where your bots run. Open Terminal on your computer, paste the command, and answer yes.`}
            </Text>
            <Text style={styles.muted}>
              {invite.hasToken
                ? "The link holds a private access key from the person who sent it. Only use links from people you trust, and do not share it. It runs code on your computer."
                : "It runs code on your computer. Only add providers from people you trust."}
            </Text>
            <Button
              variant="default"
              leftIcon={Copy}
              onPress={handleCopy}
              testID="provider-link-copy"
            >
              {copied ? "Copied" : "Copy the command"}
            </Button>
            {copied ? (
              <Text style={styles.muted} testID="provider-link-copied">
                {isNative
                  ? "With Handoff on, you can paste it straight into Terminal on your Mac. New bot chats use the provider at once."
                  : "Paste it into Terminal on the computer your bots run on. New bot chats use the provider at once."}
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.text} testID="provider-link-invalid">
            This provider link is not complete. Ask the person who sent it for a new one.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: {
    flex: 1,
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[6],
    gap: theme.spacing[4],
    ...setupColumnStyle,
  },
  card: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
