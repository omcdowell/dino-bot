import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Copy } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { APP_DISPLAY_NAME, APP_LINK_SCHEME } from "@/constants/flavour";
import { providerAddCommand, providerInviteFromIncoming } from "@/hosts/pair-deep-link";
import { setupColumnStyle } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHosts } from "@/runtime/host-runtime";
import { botsRpc } from "@/onboarding/bots-rpc";
import {
  afterInstall,
  installInputFromLink,
  installStepCopy,
  isUnsupportedRpcError,
  PROVIDER_RPC,
  signInRoute,
  type InstallStatus,
  type ProviderListAnswer,
} from "@/onboarding/provider-model";

const MutedSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/** Can this host install from the app? "old": its daemon predates provider.* (copy the command). */
type Support = "checking" | "yes" | "old" | "no-dinobot" | { error: string };

/**
 * A provider invite link opened on the phone or the desktop app (`<scheme>://provider/add?…`, e.g. a
 * private provider package the owner shares). Providers are installed on the computer, where the
 * bots run: this screen shows what the link adds, asks "Install on <computer>?", and has that
 * computer install it (bots plugin provider.install; `pi install`, no sudo), then goes straight on
 * to the sign-in the new provider needs. The link's access key goes to that computer only, which
 * keeps it (0600); it is never shown here or stored by the app. A computer whose daemon is too old
 * for that gets the old way: copy one command to paste into its Terminal.
 */
export default function ProviderLinkScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ link?: string; serverId?: string }>();
  const link = typeof params.link === "string" ? params.link : "";
  const invite = useMemo(() => providerInviteFromIncoming(link, APP_LINK_SCHEME), [link]);
  const hosts = useHosts();
  const [picked, setPicked] = useState<string | null>(
    typeof params.serverId === "string" && params.serverId ? params.serverId : null,
  );
  const serverId = picked ?? (hosts.length === 1 ? (hosts[0]?.serverId ?? null) : null);
  const hostName = hosts.find((h) => h.serverId === serverId)?.label ?? "your computer";
  const support = useHostSupport(invite ? serverId : null);
  const { job, busy, startError, install, reset } = useInstallJob(serverId, invite?.link ?? null);
  const handleBack = useCallback(() => router.replace("/" as Href), [router]);
  const bodyStyle = useMemo(
    () => [styles.body, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );

  return (
    <View style={styles.container} testID="provider-link-screen">
      <BackHeader title="Add a model provider" onBack={handleBack} />
      <ScrollView contentContainerStyle={bodyStyle}>
        {invite ? (
          <>
            <InviteCard invite={invite} />
            {hosts.length > 1 && !job ? (
              <HostPicker hosts={hosts} selected={serverId} onPick={setPicked} />
            ) : null}
            {hosts.length === 0 ? (
              <Text style={styles.text} testID="provider-link-no-host">
                {`Connect ${APP_DISPLAY_NAME} to your computer first, then open the link again.`}
              </Text>
            ) : null}
            {serverId ? (
              <InstallPanel
                support={support}
                job={job}
                hostName={hostName}
                busy={busy}
                startError={startError}
                command={providerAddCommand(invite, APP_LINK_SCHEME)}
                onInstall={install}
                onRetry={reset}
                onDone={handleBack}
              />
            ) : null}
          </>
        ) : (
          <Text style={styles.text} testID="provider-link-invalid">
            This provider link is not complete. Ask the person who sent it for a new one.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

/** Asks the chosen computer whether it can install from here (provider.list). */
function useHostSupport(serverId: string | null): Support {
  const [support, setSupport] = useState<Support>("checking");
  useEffect(() => {
    if (!serverId) return undefined;
    let live = true;
    setSupport("checking");
    botsRpc<ProviderListAnswer>(serverId, PROVIDER_RPC.list, {})
      .then((r) => live && setSupport(r.available ? "yes" : "no-dinobot"))
      .catch((e: unknown) => {
        if (!live) return;
        setSupport(isUnsupportedRpcError(e) ? "old" : { error: (e as Error).message });
      });
    return () => {
      live = false;
    };
  }, [serverId]);
  return support;
}

/**
 * provider.install on `serverId`, then its progress (polled while it runs); when done and the new
 * provider needs a sign-in, straight on to it (a plugin that replaces "anthropic": the Claude login).
 */
function useInstallJob(serverId: string | null, link: string | null) {
  const router = useRouter();
  const [job, setJob] = useState<InstallStatus | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runningId = job && job.state === "running" ? job.jobId : null;
  useEffect(() => {
    if (!runningId || !serverId) return undefined;
    const timer = setInterval(() => {
      botsRpc<InstallStatus>(serverId, PROVIDER_RPC.installStatus, { jobId: runningId })
        .then(setJob)
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [runningId, serverId]);

  const after = job?.state === "done" ? afterInstall(job) : null;
  const signInOption = after?.kind === "signin" ? after.optionId : null;
  useEffect(() => {
    if (signInOption && serverId) router.replace(signInRoute(serverId, signInOption) as Href);
  }, [signInOption, router, serverId]);

  const start = useCallback(async () => {
    const input = link ? installInputFromLink(link, APP_LINK_SCHEME) : null;
    if (!serverId || !input) return;
    setBusy(true);
    setStartError(null);
    try {
      setJob(await botsRpc<InstallStatus>(serverId, PROVIDER_RPC.install, input));
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [link, serverId]);
  const install = useCallback(() => void start(), [start]);
  const reset = useCallback(() => {
    setJob(null);
    setStartError(null);
  }, []);
  return { job, busy, startError, install, reset };
}

function InviteCard({
  invite,
}: {
  invite: { name: string | null; source: string; hasToken: boolean };
}) {
  return (
    <>
      <View style={styles.card}>
        <Text style={styles.title}>{invite.name ?? "Model provider"}</Text>
        <Text style={styles.muted} selectable>
          {invite.source}
        </Text>
      </View>
      <Text style={styles.muted}>
        {invite.hasToken
          ? "The link holds a private access key from the person who sent it. Only use links from people you trust, and do not share it. It runs code on your computer."
          : "It runs code on your computer. Only add providers from people you trust."}
      </Text>
    </>
  );
}

function hostRowStyle({ pressed }: PressableStateCallbackType) {
  return [styles.card, pressed && styles.pressed];
}

function HostPicker({
  hosts,
  selected,
  onPick,
}: {
  hosts: ReadonlyArray<{ serverId: string; label: string }>;
  selected: string | null;
  onPick: (serverId: string) => void;
}) {
  return (
    <>
      <Text style={styles.text}>Which computer?</Text>
      {hosts.map((h) => (
        <HostRow key={h.serverId} host={h} selected={h.serverId === selected} onPick={onPick} />
      ))}
    </>
  );
}

function HostRow({
  host,
  selected,
  onPick,
}: {
  host: { serverId: string; label: string };
  selected: boolean;
  onPick: (serverId: string) => void;
}) {
  const handlePress = useCallback(() => onPick(host.serverId), [host.serverId, onPick]);
  return (
    <Pressable
      onPress={handlePress}
      style={hostRowStyle}
      testID={`provider-link-host-${host.serverId}`}
    >
      <Text style={styles.title}>{`${selected ? "● " : "○ "}${host.label}`}</Text>
    </Pressable>
  );
}

interface InstallPanelProps {
  support: Support;
  job: InstallStatus | null;
  hostName: string;
  busy: boolean;
  startError: string | null;
  command: string;
  onInstall: () => void;
  onRetry: () => void;
  onDone: () => void;
}

function InstallPanel(props: InstallPanelProps) {
  const { support, job, hostName } = props;
  if (job) return <JobPanel job={job} onRetry={props.onRetry} onDone={props.onDone} />;
  if (support === "checking") {
    return (
      <View style={styles.row}>
        <MutedSpinner />
        <Text style={styles.text}>{`Asking ${hostName}…`}</Text>
      </View>
    );
  }
  if (support === "old" || support === "no-dinobot")
    return <CopyFallback command={props.command} />;
  if (typeof support === "object") {
    return (
      <Text style={styles.error} testID="provider-link-host-error">
        {`Could not reach ${hostName}: ${support.error}`}
      </Text>
    );
  }
  return (
    <>
      <Text style={styles.text}>{`Install on ${hostName}?`}</Text>
      <Text style={styles.muted}>
        {`${hostName} downloads and installs it for your bots. Nothing needs an admin password.`}
      </Text>
      {props.startError ? (
        <Text style={styles.error} testID="provider-link-start-error">
          {props.startError}
        </Text>
      ) : null}
      <Button
        variant="default"
        onPress={props.onInstall}
        loading={props.busy}
        disabled={props.busy}
        testID="provider-link-install"
      >
        {`Install on ${hostName}`}
      </Button>
    </>
  );
}

function JobPanel({
  job,
  onRetry,
  onDone,
}: {
  job: InstallStatus;
  onRetry: () => void;
  onDone: () => void;
}) {
  if (job.state === "error") {
    return (
      <>
        <Text style={styles.error} testID="provider-link-error">
          {job.error ?? "It could not be installed."}
        </Text>
        <Button onPress={onRetry}>Try again</Button>
      </>
    );
  }
  if (job.state !== "done") {
    return (
      <View style={styles.row} testID="provider-link-progress">
        <MutedSpinner />
        <Text style={styles.text}>{installStepCopy(job.step)}</Text>
      </View>
    );
  }
  const after = afterInstall(job);
  if (after.kind === "signin") {
    return (
      <View style={styles.row}>
        <MutedSpinner />
        <Text style={styles.text}>{`Installed. Opening the sign-in: ${after.label}…`}</Text>
      </View>
    );
  }
  return (
    <>
      <Text style={styles.ok} testID="provider-link-done">
        {after.kind === "ready"
          ? `✓ Installed and ready${
              after.labels.length ? `: ${after.labels.join(", ")}` : ""
            }. New bot chats can use it now.`
          : `✓ Installed. ${after.providers.join(
              ", ",
            )} has no sign-in in ${APP_DISPLAY_NAME}; if it needs one, set it up on the computer.`}
      </Text>
      <Button variant="default" onPress={onDone}>
        Done
      </Button>
    </>
  );
}

/** A daemon from before provider.install: the old way, one command for the computer's Terminal. */
function CopyFallback({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
  }, [command]);
  const handleCopy = useCallback(() => void copy(), [copy]);
  return (
    <View style={styles.fallback} testID="provider-link-fallback">
      <Text style={styles.muted}>
        {`This computer's ${APP_DISPLAY_NAME} is too old to install from here. Update it, or open Terminal on the computer, paste the command, and answer yes.`}
      </Text>
      <Button variant="default" leftIcon={Copy} onPress={handleCopy} testID="provider-link-copy">
        {copied ? "Copied" : "Copy the command"}
      </Button>
      {copied ? (
        <Text style={styles.muted} testID="provider-link-copied">
          {isNative
            ? "With Handoff on, you can paste it straight into Terminal on your Mac. New bot chats use the provider at once."
            : "Paste it into Terminal on the computer your bots run on. New bot chats use the provider at once."}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: {
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
  pressed: { opacity: 0.7 },
  fallback: { gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  ok: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
