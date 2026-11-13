import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { botsRpc } from "@/onboarding/bots-rpc";
import {
  isUnsupportedRpcError,
  packageLabel,
  PROVIDER_RPC,
  signInRoute,
  type ProviderListAnswer,
  type ProviderRow,
} from "@/onboarding/provider-model";

/**
 * Settings → host → Providers, on a DinoBot computer: the model providers the bots sign in to (pi's,
 * in DinoBot's pi dir), each ready or needing a sign-in, with a Sign in button that reuses the
 * setup sign-in screen outside onboarding; the provider packages added there (removable); and
 * "Add a provider" (every built-in sign-in, plus installing from a link). Nothing shows on a host
 * without DinoBot or with a daemon from before provider.* (bots plugin RPCs).
 */
export function BotProvidersSection({ serverId }: { serverId: string }) {
  const router = useRouter();
  const [answer, setAnswer] = useState<ProviderListAnswer | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await botsRpc<ProviderListAnswer>(serverId, PROVIDER_RPC.list, {});
      if (!r.available) setHidden(true);
      else setAnswer(r);
    } catch (e) {
      if (isUnsupportedRpcError(e)) setHidden(true);
      else setError((e as Error).message);
    }
  }, [serverId]);
  // Again whenever the screen is shown (back from a sign-in or an install).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const signIn = useCallback(
    (optionId: string | null) => router.push(signInRoute(serverId, optionId) as Href),
    [router, serverId],
  );
  const addProvider = useCallback(() => signIn(null), [signIn]);

  const remove = useCallback(
    async (source: string) => {
      const yes = await confirmDialog({
        title: `Remove ${packageLabel(source)}?`,
        message: "New bot chats and workers stop loading it. You can add it again from its link.",
        confirmLabel: "Remove",
        destructive: true,
      });
      if (!yes) return;
      setRemoving(source);
      try {
        await botsRpc(serverId, PROVIDER_RPC.remove, { source });
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setRemoving(null);
      }
    },
    [load, serverId],
  );

  if (hidden) return null;
  const added = answer?.packages.filter((p) => !p.bundled) ?? [];
  return (
    <SettingsSection
      title="Bot sign-ins"
      testID="host-page-bot-providers-card"
      style={styles.section}
    >
      <View style={settingsStyles.card}>
        {error ? (
          <View style={styles.pad}>
            <Text style={styles.error} testID="bot-providers-error">
              {error}
            </Text>
          </View>
        ) : null}
        {!answer && !error ? (
          <View style={styles.pad}>
            <Text style={styles.muted}>Asking your computer…</Text>
          </View>
        ) : null}
        {answer && answer.providers.length === 0 ? (
          <View style={styles.pad}>
            <Text style={styles.muted}>No sign-ins yet.</Text>
          </View>
        ) : null}
        {answer?.providers.map((row, i) => (
          <BotProviderRow key={row.provider} row={row} isFirst={i === 0} onSignIn={signIn} />
        ))}
        {added.map((p) => (
          <PackageRow
            key={p.source}
            source={p.source}
            removing={removing === p.source}
            onRemove={remove}
          />
        ))}
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <Button
            variant="default"
            onPress={addProvider}
            testID="bot-providers-add"
            style={styles.grow}
          >
            Add a provider
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

function BotProviderRow({
  row,
  isFirst,
  onSignIn,
}: {
  row: ProviderRow;
  isFirst: boolean;
  onSignIn: (optionId: string | null) => void;
}) {
  const handleSignIn = useCallback(() => onSignIn(row.optionId), [onSignIn, row.optionId]);
  return (
    <View
      style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder, styles.row]}
      testID={`bot-provider-${row.provider}`}
    >
      <View style={styles.text}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {row.label}
        </Text>
        <View style={styles.statusRow}>
          <View style={row.ready ? styles.dotReady : styles.dotWaiting} />
          <Text style={styles.muted}>
            {row.ready ? "Ready" : "Needs sign-in"}
            {row.plugin ? ` · via ${row.plugin}` : ""}
          </Text>
        </View>
      </View>
      {row.optionId ? (
        <Button
          variant={row.ready ? "outline" : "default"}
          size="sm"
          onPress={handleSignIn}
          testID={`bot-provider-signin-${row.provider}`}
        >
          {row.ready ? "Sign in again" : "Sign in"}
        </Button>
      ) : null}
    </View>
  );
}

function PackageRow({
  source,
  removing,
  onRemove,
}: {
  source: string;
  removing: boolean;
  onRemove: (source: string) => void;
}) {
  const handleRemove = useCallback(() => onRemove(source), [onRemove, source]);
  return (
    <View
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.row]}
      testID={`bot-package-${source}`}
    >
      <View style={styles.text}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {packageLabel(source)}
        </Text>
        <Text style={styles.muted}>Provider package</Text>
      </View>
      <Button
        variant="ghost"
        size="sm"
        onPress={handleRemove}
        loading={removing}
        disabled={removing}
        testID={`bot-package-remove-${source}`}
      >
        Remove
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { marginBottom: theme.spacing[4] },
  pad: { padding: theme.spacing[4] },
  row: { gap: theme.spacing[3], minHeight: 56 },
  text: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  dotReady: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.statusSuccess },
  dotWaiting: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.statusWarning },
  grow: { flex: 1 },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
