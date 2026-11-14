import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { botsRpc } from "@/onboarding/bots-rpc";
import { packageLabel, PROVIDER_RPC, signInRoute } from "@/onboarding/provider-model";
import {
  addPackageRoute,
  claudeCodeSignInRoute,
  claudeCodeState,
  claudeCodeSummary,
  ENGINES_RPC,
  isEnginesUnsupportedError,
  piSignInStatus,
  piSummary,
  type ClaudeCodeCard as ClaudeCodeData,
  type EnginesAnswer,
  type PiCard as PiData,
  type PiSignIn,
} from "@/onboarding/engines-model";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { BotProvidersSection } from "@/screens/settings/bot-providers-section";

/**
 * Settings → host → Providers on a DinoBot computer, "Two engines" (providers redesign, option A):
 * what the bots run on. The pi card first (the default: each sign-in, ready or not, API keys shown
 * only as a hint; sign in, sign in again, sign out; added packages), then the Claude Code card
 * (login, plan, version, the bots on it; log in, log out), then "Add" and "Other tools".
 * A daemon from before engines.* gets the older Bot sign-ins list; a host without DinoBot, nothing.
 */
export function EnginesSection({
  serverId,
  onAvailabilityChange,
}: {
  serverId: string;
  /** true once the host answers as a DinoBot host, false when it has no DinoBot. */
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const router = useRouter();
  const [answer, setAnswer] = useState<EnginesAnswer | null>(null);
  const [mode, setMode] = useState<"engines" | "legacy" | "hidden">("engines");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await botsRpc<EnginesAnswer>(serverId, ENGINES_RPC.status, {});
      if (!r.available) setMode("hidden");
      else setAnswer(r);
      onAvailabilityChange?.(r.available);
    } catch (e) {
      // An older daemon: the Bot sign-ins list (it reports availability itself).
      if (isEnginesUnsupportedError(e)) setMode("legacy");
      else setError((e as Error).message);
    }
  }, [serverId, onAvailabilityChange]);
  // Again whenever the screen is shown (back from a sign-in or an install).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const go = useCallback((route: string) => router.push(route as Href), [router]);
  const signIn = useCallback(
    (optionId: string | null) => go(signInRoute(serverId, optionId)),
    [go, serverId],
  );
  const addSignIn = useCallback(() => signIn(null), [signIn]);
  const addPackage = useCallback(() => go(addPackageRoute(serverId)), [go, serverId]);
  const claudeLogin = useCallback(() => go(claudeCodeSignInRoute(serverId)), [go, serverId]);
  const openTerminal = useCallback(
    () => go(buildNewWorkspaceRoute({ serverId })),
    [go, serverId],
  );

  /** Runs one change on the computer, then reloads; errors show on the screen. */
  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await fn();
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const signOut = useCallback(
    async (row: PiSignIn) => {
      const yes = await confirmDialog({
        title: `Sign out of ${row.label}?`,
        message:
          "Your computer forgets this sign-in. Bots and workers that use it stop working until you sign in again.",
        confirmLabel: "Sign out",
        destructive: true,
      });
      if (!yes) return;
      await act(`signout:${row.provider}`, () =>
        botsRpc(serverId, ENGINES_RPC.piSignOut, { provider: row.provider }),
      );
    },
    [act, serverId],
  );

  const removePackage = useCallback(
    async (source: string) => {
      const yes = await confirmDialog({
        title: `Remove ${packageLabel(source)}?`,
        message: "New bot chats and workers stop loading it. You can add it again from its link.",
        confirmLabel: "Remove",
        destructive: true,
      });
      if (!yes) return;
      await act(`remove:${source}`, () => botsRpc(serverId, PROVIDER_RPC.remove, { source }));
    },
    [act, serverId],
  );

  const claudeLogout = useCallback(async () => {
    const yes = await confirmDialog({
      title: "Log out of Claude Code?",
      message:
        "Claude Code on your computer logs out. Bots on Claude Code stop until you log in again.",
      confirmLabel: "Log out",
      destructive: true,
    });
    if (!yes) return;
    await act("claude-logout", () => botsRpc(serverId, ENGINES_RPC.claudeLogout, {}));
  }, [act, serverId]);

  if (mode === "hidden") return null;
  if (mode === "legacy") {
    return (
      <BotProvidersSection serverId={serverId} onAvailabilityChange={onAvailabilityChange} />
    );
  }
  return (
    <View testID="engines-section">
      <SettingsSection title="What your bots run on" style={styles.section}>
        {error ? (
          <View style={[settingsStyles.card, styles.pad]}>
            <Text style={styles.error} testID="engines-error">
              {error}
            </Text>
          </View>
        ) : null}
        {!answer && !error ? (
          <View style={[settingsStyles.card, styles.pad]}>
            <Text style={styles.muted}>Asking your computer…</Text>
          </View>
        ) : null}
        {answer?.error ? (
          <View style={[settingsStyles.card, styles.pad]}>
            <Text style={styles.error}>{answer.error}</Text>
          </View>
        ) : null}
        {answer?.pi ? (
          <PiCardView
            card={answer.pi}
            busy={busy}
            onSignIn={signIn}
            onSignOut={signOut}
            onRemovePackage={removePackage}
            onAdd={addSignIn}
          />
        ) : null}
        {answer?.claudeCode ? (
          <ClaudeCodeCardView
            card={answer.claudeCode}
            busy={busy === "claude-logout"}
            onLogin={claudeLogin}
            onLogout={claudeLogout}
          />
        ) : null}
      </SettingsSection>

      {answer ? (
        <>
          <SettingsSection title="Add" style={styles.section}>
            <View style={settingsStyles.card}>
              <LinkRow
                icon="+"
                title="Add a key or login for pi"
                hint="ChatGPT, Copilot, OpenRouter, OpenAI, Anthropic, …"
                onPress={addSignIn}
                testID="engines-add-signin"
              />
              <LinkRow
                icon="⧉"
                title="Add a provider package"
                hint="From a link someone shared"
                onPress={addPackage}
                bordered
                testID="engines-add-package"
              />
            </View>
          </SettingsSection>
          <SettingsSection title="Other tools" style={styles.section}>
            <View style={settingsStyles.card}>
              <View style={[settingsStyles.row, styles.row]}>
                <View style={styles.icon}>
                  <Text style={styles.iconText}>›_</Text>
                </View>
                <View style={styles.text}>
                  <Text style={settingsStyles.rowTitle}>Codex, OpenCode, …</Text>
                  <Text style={styles.muted}>Open one in a terminal on your computer</Text>
                </View>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={openTerminal}
                  testID="engines-terminal"
                >
                  Terminal
                </Button>
              </View>
            </View>
            <Text style={styles.note}>
              Keys stay on your computer, in pi&apos;s sign-in file that only your user can read.
              This app shows only a key&apos;s last 4 characters and never puts a key in a chat.
            </Text>
          </SettingsSection>
        </>
      ) : null}
    </View>
  );
}

function StatusLine({ ok, text, testID }: { ok: boolean; text: string; testID?: string }) {
  return (
    <View style={styles.statusRow}>
      <View style={ok ? styles.dotReady : styles.dotWaiting} />
      <Text style={styles.muted} testID={testID}>
        {text}
      </Text>
    </View>
  );
}

function CardHeader({
  glyph,
  glyphStyle,
  title,
  status,
  testID,
}: {
  glyph: string;
  glyphStyle: "pi" | "claude";
  title: string;
  status: { ok: boolean; text: string };
  testID: string;
}) {
  return (
    <View style={[settingsStyles.row, styles.row]}>
      <View style={glyphStyle === "pi" ? styles.glyphPi : styles.glyphClaude}>
        <Text style={glyphStyle === "pi" ? styles.glyphPiText : styles.glyphClaudeText}>
          {glyph}
        </Text>
      </View>
      <View style={styles.text}>
        <Text style={styles.cardTitle}>{title}</Text>
        <StatusLine ok={status.ok} text={status.text} testID={testID} />
      </View>
    </View>
  );
}

function PiCardView({
  card,
  busy,
  onSignIn,
  onSignOut,
  onRemovePackage,
  onAdd,
}: {
  card: PiData;
  busy: string | null;
  onSignIn: (optionId: string | null) => void;
  onSignOut: (row: PiSignIn) => void;
  onRemovePackage: (source: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const added = card.packages.filter((p) => !p.bundled);
  return (
    <View style={[settingsStyles.card, styles.heroSelected]} testID="engine-pi">
      <CardHeader
        glyph="π"
        glyphStyle="pi"
        title="pi"
        status={piSummary(card)}
        testID="engine-pi-status"
      />
      <Text style={styles.blurb}>
        Runs your bots and workers on any model, with your own keys or logins.
      </Text>
      {card.signins.length === 0 ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <Text style={[styles.muted, styles.text]}>No sign-ins yet.</Text>
          <Button variant="default" size="sm" onPress={onAdd} testID="engine-pi-first-signin">
            Sign in
          </Button>
        </View>
      ) : null}
      {card.signins.map((row) => (
        <PiSignInRow
          key={row.provider}
          row={row}
          open={open === row.provider}
          busy={busy === `signout:${row.provider}`}
          onToggle={setOpen}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
        />
      ))}
      {added.map((p) => (
        <PackageRow
          key={p.source}
          source={p.source}
          removing={busy === `remove:${p.source}`}
          onRemove={onRemovePackage}
        />
      ))}
    </View>
  );
}

function PiSignInRow({
  row,
  open,
  busy,
  onToggle,
  onSignIn,
  onSignOut,
}: {
  row: PiSignIn;
  open: boolean;
  busy: boolean;
  onToggle: (provider: string | null) => void;
  onSignIn: (optionId: string | null) => void;
  onSignOut: (row: PiSignIn) => void;
}) {
  const status = piSignInStatus(row);
  const toggle = useCallback(
    () => onToggle(open ? null : row.provider),
    [onToggle, open, row.provider],
  );
  const signIn = useCallback(() => onSignIn(row.optionId), [onSignIn, row.optionId]);
  const signOut = useCallback(() => onSignOut(row), [onSignOut, row]);
  return (
    <View style={settingsStyles.rowBorder} testID={`engine-pi-signin-${row.provider}`}>
      <Pressable
        onPress={toggle}
        style={[settingsStyles.row, styles.signinRow]}
        accessibilityRole="button"
        testID={`engine-pi-row-${row.provider}`}
      >
        <View style={styles.text}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {row.label}
          </Text>
          {row.plugin ? <Text style={styles.muted}>{`via ${row.plugin}`}</Text> : null}
        </View>
        {status.isKey ? (
          <Text style={styles.keyChip} testID={`engine-pi-key-${row.provider}`}>
            {status.text}
          </Text>
        ) : (
          <StatusLine ok={status.ok} text={status.text} />
        )}
      </Pressable>
      {open || !row.ready ? (
        <View style={styles.actions}>
          {row.optionId ? (
            <Button
              variant={row.ready ? "outline" : "default"}
              size="sm"
              onPress={signIn}
              testID={`engine-pi-signin-btn-${row.provider}`}
            >
              {row.ready ? "Sign in again" : "Sign in"}
            </Button>
          ) : null}
          {row.canSignOut ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={signOut}
              loading={busy}
              disabled={busy}
              testID={`engine-pi-signout-${row.provider}`}
            >
              Sign out
            </Button>
          ) : null}
        </View>
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
      testID={`engine-pi-package-${source}`}
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
        testID={`engine-pi-package-remove-${source}`}
      >
        Remove
      </Button>
    </View>
  );
}

function ClaudeCodeCardView({
  card,
  busy,
  onLogin,
  onLogout,
}: {
  card: ClaudeCodeData;
  busy: boolean;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const state = claudeCodeState(card);
  return (
    <View style={[settingsStyles.card, styles.hero]} testID="engine-claude-code">
      <CardHeader
        glyph={"\u2733\uFE0E"}
        glyphStyle="claude"
        title="Claude Code"
        status={claudeCodeSummary(card)}
        testID="engine-claude-status"
      />
      <Text style={styles.blurb}>
        Runs the real Claude Code app on your computer, with OptChat memory. Uses your Claude plan,
        not extra usage.
      </Text>
      {card.warning ? <Text style={[styles.blurb, styles.warn]}>{card.warning}</Text> : null}
      {state === "error" && card.error ? (
        <Text style={[styles.blurb, styles.error]}>{card.error}</Text>
      ) : null}
      {state === "not-installed" ? (
        <Text style={styles.blurb} testID="engine-claude-install">
          Install Claude Code on your computer first (claude.com/download), then log in here.
        </Text>
      ) : (
        <>
          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.metaRow]}>
            <Text style={styles.metaLabel}>Bots on it</Text>
            <Text style={styles.metaValue} numberOfLines={1} testID="engine-claude-bots">
              {card.bots.length ? card.bots.join(", ") : "None yet"}
            </Text>
          </View>
          <View style={[settingsStyles.row, styles.metaRow]}>
            <Text style={styles.metaLabel}>Version</Text>
            <View style={styles.metaRight}>
              <Text style={styles.metaValue}>{card.version ?? "?"}</Text>
              <Text
                style={card.modsReady ? styles.chipOk : styles.chipWarn}
                testID="engine-claude-mods"
              >
                {card.modsReady ? "mods ready" : "update for mods"}
              </Text>
            </View>
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.actionsRow]}>
            {state === "logged-in" ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={onLogout}
                loading={busy}
                disabled={busy}
                testID="engine-claude-logout"
              >
                Log out
              </Button>
            ) : (
              <Button
                variant="default"
                size="sm"
                onPress={onLogin}
                testID="engine-claude-login"
              >
                Log in with Claude
              </Button>
            )}
          </View>
        </>
      )}
    </View>
  );
}

function LinkRow({
  icon,
  title,
  hint,
  onPress,
  bordered,
  testID,
}: {
  icon: string;
  title: string;
  hint: string;
  onPress: () => void;
  bordered?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[settingsStyles.row, bordered && settingsStyles.rowBorder, styles.row]}
      testID={testID}
    >
      <View style={styles.icon}>
        <Text style={styles.iconText}>{icon}</Text>
      </View>
      <View style={styles.text}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={styles.muted} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { marginBottom: theme.spacing[4] },
  pad: { padding: theme.spacing[4] },
  hero: { marginTop: theme.spacing[3] },
  heroSelected: { borderColor: theme.colors.accent },
  row: { gap: theme.spacing[3], minHeight: 56 },
  signinRow: { gap: theme.spacing[3], paddingVertical: theme.spacing[3] },
  text: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  blurb: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  dotReady: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.statusSuccess },
  dotWaiting: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.statusWarning },
  glyphPi: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphPiText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  glyphClaude: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.statusWarningTint,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphClaudeText: { color: "#e8a27c", fontSize: theme.fontSize.lg },
  keyChip: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: "Menlo",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    overflow: "hidden",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  actionsRow: { justifyContent: "flex-end", paddingVertical: theme.spacing[2] },
  metaRow: { paddingVertical: theme.spacing[2] },
  metaLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  metaValue: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
  metaRight: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  chipOk: {
    color: theme.colors.statusSuccess,
    backgroundColor: theme.colors.statusSuccessTint,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    overflow: "hidden",
  },
  chipWarn: {
    color: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    overflow: "hidden",
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  chevron: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.lg },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warn: { color: theme.colors.statusWarning },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[3],
    marginHorizontal: theme.spacing[1],
  },
}));
