import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { APP_DISPLAY_NAME, RELEASE_POLICY } from "@/constants/flavour";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  IMPORT_INTRO,
  SETUP_RPC,
  importWarning,
  initialSetupState,
  type ImportEstimate,
  type SetupState,
} from "@/onboarding/setup-model";
import { routeAfterStep } from "@/onboarding/setup-store";
import { setupColumnStyle } from "@/constants/layout";

type Scan = { signIn?: string; estimate?: ImportEstimate } | null;

/** The host's import scan, or null when its bots plugin has no setup RPCs (older plugin). */
async function scanHost(serverId: string, state: SetupState): Promise<Scan> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) return null;
  try {
    const out = await client.invokePluginRpc(SETUP_RPC.pluginId, SETUP_RPC.scan, {
      days: state.importDays,
      includeScratch: state.includeScratch,
    });
    return out && typeof out === "object" ? (out as Scan) : null;
  } catch {
    return null;
  }
}

/**
 * Onboarding step "import" (ReleasePolicy.onboardingSteps): the optional chat import (off by
 * default, last 90 days, ~/scratch worker sessions unticked). Continue hands it to the host and
 * moves on at once; the import runs in the background on the host. Models are chosen in the
 * step before (setup-models), from pi's own list.
 */
export default function SetupScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const [state, setState] = useState<SetupState>(() => initialSetupState(RELEASE_POLICY));
  const [scan, setScan] = useState<Scan>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!serverId || !state.importEnabled) return;
    let cancelled = false;
    setScanning(true);
    const run = async () => {
      const result = await scanHost(serverId, state);
      if (cancelled) return;
      setScan(result);
      setScanning(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [serverId, state]);

  const leave = useCallback(() => {
    if (!serverId) return router.replace("/" as Href);
    void routeAfterStep("import", serverId).then((route) => router.replace(route as Href));
  }, [router, serverId]);

  const handleContinue = useCallback(() => {
    const client = serverId ? getHostRuntimeStore().getClient(serverId) : null;
    // Fire and forget: the host starts the import detached; the app never waits on it.
    if (state.importEnabled) {
      void client
        ?.invokePluginRpc(SETUP_RPC.pluginId, SETUP_RPC.apply, {
          import: { days: state.importDays, includeScratch: state.includeScratch },
        })
        .catch(() => undefined);
    }
    leave();
  }, [serverId, state, leave]);

  const setImport = useCallback(
    (importEnabled: boolean) => setState((s) => ({ ...s, importEnabled })),
    [],
  );
  const setScratch = useCallback(
    (includeScratch: boolean) => setState((s) => ({ ...s, includeScratch })),
    [],
  );
  const setDays = useCallback(
    (value: "90" | "all") => setState((s) => ({ ...s, importDays: value === "all" ? null : 90 })),
    [],
  );

  const warning = scan?.estimate
    ? importWarning(scan.estimate, { showPlanPercent: RELEASE_POLICY.importShowPlanPercent })
    : null;
  const contentStyle = useMemo(
    () => [styles.content, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );

  return (
    <View style={styles.container} testID="setup-screen">
      <BackHeader title={`Set up ${APP_DISPLAY_NAME}: past chats`} onBack={leave} />
      <ScrollView contentContainerStyle={contentStyle}>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.title}>Import past chats</Text>
            <Switch
              value={state.importEnabled}
              onValueChange={setImport}
              accessibilityLabel="Import past chats"
              testID="setup-import"
            />
          </View>
          <Text style={styles.body}>{IMPORT_INTRO}</Text>
          {state.importEnabled ? (
            <>
              <SegmentedControl
                options={[
                  { value: "90", label: "Last 90 days", testID: "setup-import-90" },
                  { value: "all", label: "Everything", testID: "setup-import-all" },
                ]}
                value={state.importDays === null ? "all" : "90"}
                onValueChange={setDays}
              />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Include worker sessions in ~/scratch</Text>
                <Switch
                  value={state.includeScratch}
                  onValueChange={setScratch}
                  accessibilityLabel="Include worker sessions in ~/scratch"
                  testID="setup-import-scratch"
                />
              </View>
              <Text style={styles.warning} testID="setup-import-warning">
                {scanning
                  ? "Counting your past chats…"
                  : (warning ??
                    "Importing your old chats will use a lot of your subscription. It runs in the background; your bot works meanwhile and gets the old chats when it finishes. It pauses when you hit a limit and carries on later.")}
              </Text>
            </>
          ) : null}
        </View>

        <Button variant="default" onPress={handleContinue} testID="setup-continue">
          Continue
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[6], gap: theme.spacing[4], ...setupColumnStyle },
  card: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  body: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  extraUsage: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  warning: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flex: 1 },
}));
