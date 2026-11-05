import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, ScrollView } from "react-native";
import { useRouter, type Href } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  QrCode,
  Link2,
  ClipboardPaste,
  ExternalLink,
  Settings,
  Terminal,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostProfile } from "@/types/host-connection";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { AddHostModal } from "./add-host-modal";
import { AddRemoteSshHostModal } from "./add-remote-ssh-host-modal";
import { PairLinkModal } from "./pair-link-modal";
import { Button } from "@/components/ui/button";
import { resolveDisplayVersion } from "@/utils/app-version";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { openExternalUrl } from "@/utils/open-external-url";
import { isFdroidBuild } from "@/constants/build-profile";
import { isWeb, isNative } from "@/constants/platform";
import { isElectronRuntime } from "@/desktop/host";
import * as Clipboard from "expo-clipboard";
import {
  APP_INSTALL_URL,
  APP_LINK_SCHEME,
  RELEASE_POLICY,
  installCommand,
} from "@/constants/flavour";
import { routeAfterPairing } from "@/onboarding/setup-store";
import { useIsFocused } from "@react-navigation/native";

interface WelcomeAction {
  key: "scan-qr" | "direct-connection" | "remote-ssh" | "paste-pairing-link";
  label: string;
  testID: string;
  primary: boolean;
  icon: typeof QrCode;
  onPress: () => void;
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: theme.spacing[6],
    paddingBottom: 0,
    alignItems: "center",
  },
  content: {
    width: "100%",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  copyBlock: {
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[12],
  },
  actions: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[3],
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionButtonPrimary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  actionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actionTextPrimary: {
    color: theme.colors.accentForeground,
  },
  setupLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  setupLinkText: {
    color: theme.colors.accentText,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  installStep: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  installTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  installCommand: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  installCommandText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: "Menlo",
  },
  installHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  versionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[6],
  },
  settingsButton: {
    alignSelf: "center",
    marginTop: theme.spacing[6],
  },
}));

function useAnyHostOnline(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
  );
}

export interface WelcomeScreenProps {
  onHostAdded?: (profile: HostProfile) => void;
}

export function WelcomeScreen({ onHostAdded }: WelcomeScreenProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const appVersionText = formatVersionWithPrefix(resolveDisplayVersion());
  const [isDirectOpen, setIsDirectOpen] = useState(false);
  const [isRemoteSshOpen, setIsRemoteSshOpen] = useState(false);
  const [isPasteLinkOpen, setIsPasteLinkOpen] = useState(false);
  const hosts = useHosts();
  const anyOnlineServerId = useAnyHostOnline(hosts.map((h) => h.serverId));

  // Public flavour: a newly paired host goes through the one-time setup step first.
  const finishOnboardingFor = useCallback(
    (serverId: string | null) => {
      if (!serverId || !RELEASE_POLICY.importOnboarding) {
        router.replace(buildOpenProjectRoute());
        return;
      }
      void routeAfterPairing(serverId)
        .catch(() => buildOpenProjectRoute())
        .then((route) => router.replace(route as Href));
    },
    [router],
  );

  // Only while this screen is on top, and once per host: with /pair pushed over it (a pairing link),
  // the pair screen routes on; repeating the redirect replaced the setup screens over and over
  // (seen on the DinoBot desktop app, which restarted its sign-in check each time).
  const isFocused = useIsFocused();
  const routedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!anyOnlineServerId || !isFocused || routedFor.current === anyOnlineServerId) return;
    routedFor.current = anyOnlineServerId;
    finishOnboardingFor(anyOnlineServerId);
  }, [anyOnlineServerId, finishOnboardingFor, isFocused]);

  const handleOpenPaseoSite = useCallback(() => {
    void openExternalUrl("https://paseo.sh");
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);

  const handleOpenDirect = useCallback(() => setIsDirectOpen(true), []);
  const handleCloseDirect = useCallback(() => setIsDirectOpen(false), []);
  const handleOpenRemoteSsh = useCallback(() => setIsRemoteSshOpen(true), []);
  const handleCloseRemoteSsh = useCallback(() => setIsRemoteSshOpen(false), []);
  const handleOpenPasteLink = useCallback(() => setIsPasteLinkOpen(true), []);
  const handleClosePasteLink = useCallback(() => setIsPasteLinkOpen(false), []);
  const handleScanQr = useCallback(() => {
    router.push("/pair-scan?source=onboarding");
  }, [router]);

  const handleHostSaved = useCallback(
    ({ profile, serverId }: { profile: HostProfile; serverId: string }) => {
      onHostAdded?.(profile);
      finishOnboardingFor(serverId);
    },
    [onHostAdded, finishOnboardingFor],
  );

  const actions: WelcomeAction[] =
    isWeb || isFdroidBuild
      ? [
          {
            key: "direct-connection",
            label: t("pairing.connectionMethods.direct.title"),
            testID: "welcome-direct-connection",
            primary: true,
            icon: Link2,
            onPress: handleOpenDirect,
          },
          {
            key: "paste-pairing-link",
            label: t("pairing.connectionMethods.pasteLink.title"),
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: handleOpenPasteLink,
          },
        ]
      : [
          {
            key: "scan-qr",
            label: t("pairing.connectionMethods.scanQr.title"),
            testID: "welcome-scan-qr",
            primary: true,
            icon: QrCode,
            onPress: handleScanQr,
          },
          {
            key: "direct-connection",
            label: t("pairing.connectionMethods.direct.title"),
            testID: "welcome-direct-connection",
            primary: false,
            icon: Link2,
            onPress: handleOpenDirect,
          },
          {
            key: "paste-pairing-link",
            label: t("pairing.connectionMethods.pasteLink.title"),
            testID: "welcome-paste-pairing-link",
            primary: false,
            icon: ClipboardPaste,
            onPress: handleOpenPasteLink,
          },
        ];

  // Public flavour: Tailscale only, so no manual host:port entry (that is the LAN path); pairing
  // is the setup QR (camera or phone camera deep link) or its pasted link.
  if (RELEASE_POLICY.tailnetOnly) {
    const index = actions.findIndex((action) => action.key === "direct-connection");
    if (index >= 0) actions.splice(index, 1);
    if (actions[0]) actions[0].primary = true;
  }

  if (isElectronRuntime() && RELEASE_POLICY.desktopRemoteSsh) {
    actions.splice(1, 0, {
      key: "remote-ssh",
      label: t("pairing.connectionMethods.remoteSsh.title"),
      testID: "welcome-remote-ssh",
      primary: false,
      icon: Terminal,
      onPress: handleOpenRemoteSsh,
    });
  }

  const scrollContentContainerStyle = useMemo(
    () => [styles.container, { paddingBottom: theme.spacing[6] + insets.bottom }],
    [theme.spacing, insets.bottom],
  );

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={scrollContentContainerStyle}
        showsVerticalScrollIndicator={false}
        testID="welcome-screen"
      >
        <View style={styles.content}>
          <PaseoLogo size={96} />
          <View style={styles.copyBlock}>
            <Text style={styles.title}>{t("onboarding.title")}</Text>
            <Text style={styles.subtitle}>{t("onboarding.subtitle")}</Text>
            {/* paseo.sh is upstream's site: not linked from the public app. */}
            {isNative && !RELEASE_POLICY.debrand ? (
              <Pressable style={styles.setupLink} onPress={handleOpenPaseoSite}>
                <Text style={styles.setupLinkText}>paseo.sh</Text>
                <ExternalLink size={14} color={theme.colors.accentText} />
              </Pressable>
            ) : null}
          </View>

          {APP_INSTALL_URL ? <InstallStep url={APP_INSTALL_URL} /> : null}

          <View style={styles.actions}>
            {actions.map((action) => (
              <WelcomeActionButton key={action.key} action={action} />
            ))}
          </View>

          <Button
            variant="ghost"
            size="sm"
            leftIcon={Settings}
            onPress={handleOpenSettings}
            style={styles.settingsButton}
            testID="welcome-open-settings"
          >
            {t("onboarding.actions.settings")}
          </Button>
        </View>
        <Text style={styles.versionLabel}>{appVersionText}</Text>

        <AddHostModal
          visible={isDirectOpen}
          onClose={handleCloseDirect}
          onSaved={handleHostSaved}
        />

        <AddRemoteSshHostModal
          visible={isRemoteSshOpen}
          onClose={handleCloseRemoteSsh}
          onSaved={handleHostSaved}
        />

        <PairLinkModal
          visible={isPasteLinkOpen}
          onClose={handleClosePasteLink}
          onSaved={handleHostSaved}
        />
      </ScrollView>
    </View>
  );
}

/**
 * Public flavour, step 1: the one command that installs the server on a Mac or Linux computer
 * (release-flavour.js PUBLIC_INSTALL_URL). It ends in a QR code that the buttons below scan.
 * Tapping the command copies it.
 */
function InstallStep({ url }: { url: string }) {
  const command = installCommand(url);
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void Clipboard.setStringAsync(command)
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [command]);
  return (
    <View style={styles.installStep} testID="welcome-install-step">
      <Text style={styles.installTitle}>1. On your Mac or Linux computer, run:</Text>
      <Pressable
        onPress={handleCopy}
        style={styles.installCommand}
        testID="welcome-install-command"
      >
        <Text style={styles.installCommandText} selectable>
          {command}
        </Text>
      </Pressable>
      <Text style={styles.installHint}>
        {copied ? "Copied. Paste it into Terminal on your computer." : installHint()}
      </Text>
      <Text style={styles.installTitle}>{installNextStep()}</Text>
    </View>
  );
}

/** The phone scans the installer's QR; the desktop app (no camera) pastes its link instead. */
function installHint(): string {
  return isNative
    ? "Tap to copy. It installs everything and shows a QR code at the end. You also need Tailscale on your computer and this phone; setup walks you through it."
    : "Click to copy. It installs everything, then shows a QR code for a phone and the command for step 2. You also need Tailscale on that computer, and on this one if it is a different computer; setup walks you through it.";
}

function installNextStep(): string {
  return isNative
    ? "2. Scan the QR code it shows:"
    : `2. Then run ${pairLinkCommand()} there and paste the link it prints:`;
}

/** Prints the pairing link as text (installer `pair --link`), for the desktop app's paste step. */
function pairLinkCommand(): string {
  return `~/.${APP_LINK_SCHEME}/bin/${APP_LINK_SCHEME} pair --link`;
}

interface WelcomeActionButtonProps {
  action: WelcomeAction;
}

function WelcomeActionButton({ action }: WelcomeActionButtonProps) {
  const { theme } = useUnistyles();
  const Icon = action.icon;
  const buttonStyle = useMemo(
    () => [styles.actionButton, action.primary ? styles.actionButtonPrimary : null],
    [action.primary],
  );
  const textStyle = useMemo(
    () => [styles.actionText, action.primary ? styles.actionTextPrimary : null],
    [action.primary],
  );
  return (
    <Pressable style={buttonStyle} onPress={action.onPress} testID={action.testID}>
      <Icon
        size={18}
        color={action.primary ? theme.colors.accentForeground : theme.colors.foreground}
      />
      <Text style={textStyle}>{action.label}</Text>
    </Pressable>
  );
}
