import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { router as appRouter, useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ClipboardPaste, QrCode, RotateCcw } from "lucide-react-native";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { createPairAttempts } from "@/hosts/pair-scan-model";
import { BackHeader } from "@/components/headers/back-header";
import { PairLinkModal } from "@/components/pair-link-modal";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { APP_DISPLAY_NAME, RELEASE_POLICY } from "@/constants/flavour";
import { TAILSCALE_HELP } from "@/hosts/pair-deep-link";
import { routeAfterPairing } from "@/onboarding/setup-store";
import { setupColumnStyle } from "@/constants/layout";

/**
 * Pairing from a deep link (`<scheme>://pair/#offer=…`, see +native-intent.tsx): a phone-camera
 * scan of the setup QR, or a tapped link. No in-app camera is needed. Shows progress, the
 * password prompt and errors, with "paste a link" and "scan" as the ways out.
 */
const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foreground,
}));

export default function PairDeepLinkScreen() {
  const params = useLocalSearchParams<{ link?: string; at?: string }>();
  const link = typeof params.link === "string" ? params.link : "";
  const attempt = typeof params.at === "string" ? params.at : "";
  // A new link, or the same link opened again (new `at`, e.g. after Cancel), starts afresh.
  const attemptKey = `${attempt}|${link}`;
  return <PairDeepLink key={attemptKey} attemptKey={attemptKey} link={link} />;
}

/** Survives the screen being mounted again mid-attempt (see createPairAttempts). */
const pairAttempts = createPairAttempts();

function goToHost(serverId: string): void {
  void routeAfterPairing(serverId).then((route) => appRouter.replace(route as Href));
}

function PairDeepLink({ link, attemptKey }: { link: string; attemptKey: string }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [isPasteOpen, setIsPasteOpen] = useState(false);

  const [pairing] = useState(() =>
    pairAttempts.acquire(attemptKey, {
      importConnectionLink: (url) => getHostRuntimeStore().importConnectionLink(url, "hostRoot"),
      onConnected: goToHost,
    }),
  );
  const state = useSyncExternalStore(pairing.subscribe, pairing.getState, pairing.getState);
  useEffect(() => {
    // Starts the attempt once; a remount finds it running (scan() only acts while scanning).
    if (link) pairing.scan(link);
  }, [pairing, link]);

  const handleBack = useCallback(() => router.replace("/" as Href), [router]);
  const retry = useCallback(() => {
    pairing.scanAgain();
    pairing.scan(link);
  }, [pairing, link]);
  const openPaste = useCallback(() => setIsPasteOpen(true), []);
  const closePaste = useCallback(() => setIsPasteOpen(false), []);
  const openScan = useCallback(
    () => router.replace("/pair-scan?source=onboarding" as Href),
    [router],
  );
  const handlePasteSaved = useCallback(
    ({ serverId }: { serverId: string }) => goToHost(serverId),
    [],
  );

  const bodyStyle = useMemo(
    () => [styles.body, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );

  const busy = Boolean(link) && (state.status === "scanning" || state.status === "pairing");
  let message = `Connecting ${APP_DISPLAY_NAME} to your computer…`;
  if (!link) message = "This link has no pairing code. Paste the link from your computer instead.";
  else if (state.status === "stopped")
    message = state.error ?? "Pairing was cancelled. You can try again below.";
  else if (state.status === "connected") message = "Connected.";

  return (
    <View style={styles.container} testID="pair-deep-link-screen">
      <BackHeader title="Pair" onBack={handleBack} />
      <View style={bodyStyle}>
        <View style={styles.card}>
          {busy ? <ThemedSpinner /> : null}
          <Text style={styles.message} testID="pair-deep-link-message">
            {message}
          </Text>
          {state.status === "stopped" && state.error && RELEASE_POLICY.tailnetOnly ? (
            <Text style={styles.help} testID="pair-deep-link-tailscale-help">
              {TAILSCALE_HELP}
            </Text>
          ) : null}
        </View>
        {!busy && state.status !== "connected" ? (
          <View style={styles.actions}>
            {link && state.status === "stopped" ? (
              <Button
                variant="default"
                leftIcon={RotateCcw}
                onPress={retry}
                testID="pair-deep-link-retry"
              >
                Try again
              </Button>
            ) : null}
            <Button leftIcon={ClipboardPaste} onPress={openPaste} testID="pair-deep-link-paste">
              Paste pairing link
            </Button>
            <Button
              leftIcon={QrCode}
              variant="ghost"
              onPress={openScan}
              testID="pair-deep-link-scan"
            >
              Scan QR code
            </Button>
          </View>
        ) : null}
      </View>
      <PairLinkModal
        visible={state.status === "passwordRequired"}
        passwordRequired={state.status === "passwordRequired" ? state.passwordRequired : undefined}
        onClose={pairing.closePassword}
        onCancel={pairing.closePassword}
        onSaved={handlePasteSaved}
      />
      <PairLinkModal visible={isPasteOpen} onClose={closePaste} onSaved={handlePasteSaved} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: {
    flex: 1,
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[6],
    gap: theme.spacing[6],
    ...setupColumnStyle,
  },
  card: {
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[4],
    alignItems: "center",
  },
  message: { color: theme.colors.foreground, fontSize: theme.fontSize.base, textAlign: "center" },
  help: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, alignSelf: "stretch" },
  actions: { gap: theme.spacing[3] },
}));
