import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { APP_DISPLAY_NAME, APP_LINK_SCHEME } from "@/constants/flavour";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  badgeIsWarning,
  ONBOARDING_RPC,
  type SignInOption,
  type SignInStatus,
} from "@/onboarding/onboarding-model";
import { routeAfterStep } from "@/onboarding/setup-store";
import { createSignInMemory, pendingSessionId } from "@/onboarding/signin-session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { setupColumnStyle } from "@/constants/layout";
import { DEVICE_COPY } from "@/constants/device-copy";
import { providerInviteFromIncoming } from "@/hosts/pair-deep-link";
import { providerLinkRoute } from "@/onboarding/provider-model";
import { CLAUDE_CODE_OPTION_ID } from "@/onboarding/engines-model";

const ThemedTextInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));
const MutedSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

interface Options {
  available: boolean;
  options: SignInOption[];
  signedIn: string[];
  error: string | null;
}

/** Settings › Providers › Claude Code › Log in: Claude Code's own login, run by the host. */
const CLAUDE_CODE_OPTION: SignInOption = {
  id: CLAUDE_CODE_OPTION_ID,
  provider: "claude-code",
  label: "Claude Code",
  method: "paste-code",
};

/** Survives the screen being mounted again (appearance change); see signin-session-store.ts. */
const signInMemory = createSignInMemory<Options>();

/** The paired host's client; right after pairing it may still be connecting, so wait a little. */
async function hostClient(serverId: string) {
  for (let i = 0; i < 40; i++) {
    const client = getHostRuntimeStore().getClient(serverId);
    if (client) return client;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function rpc<T>(serverId: string, method: string, input: unknown): Promise<T> {
  const client = await hostClient(serverId);
  if (!client) throw new Error("Not connected to your computer yet.");
  return (await client.invokePluginRpc(ONBOARDING_RPC.pluginId, method, input)) as T;
}

/**
 * Onboarding step "signin": pick how the bots sign in. The login itself is pi-ai's, run by the
 * computer (device code or copy code, never a localhost callback), and the tokens are stored
 * there in pi's auth.json, never on this phone. Claude login is last and needs the EXTRA USAGE
 * confirm sheet first.
 */
export default function SetupSignInScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId?: string;
    from?: string;
    option?: string;
    add?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  // Opened from Settings → Providers (or after installing a provider from a link), not onboarding:
  // done goes back there, and `option` starts that sign-in at once.
  const fromSettings = params.from === "settings";
  const optionParam = typeof params.option === "string" ? params.option : "";
  // Settings › Providers › "Add a provider package": only the install-from-a-link card.
  const packageOnly = fromSettings && params.add === "package";
  // Kept outside the screen so a remount (appearance change) keeps the list and a sign-in going.
  const memory = useSyncExternalStore(
    signInMemory.subscribe,
    () => signInMemory.get(serverId),
    () => signInMemory.get(serverId),
  );
  const { options, status } = memory;
  const setOptions = useCallback(
    (o: Options | null) => signInMemory.setOptions(serverId, o),
    [serverId],
  );
  const setStatus = useCallback(
    (s: SignInStatus | null) => signInMemory.setStatus(serverId, s),
    [serverId],
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  // start/submit failures, shown on the screen (Alert.alert does nothing on web and desktop).
  const [actionError, setActionError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);

  const next = useCallback(async () => {
    signInMemory.forget(serverId);
    if (fromSettings) {
      if (router.canGoBack()) router.back();
      else router.replace("/" as Href);
      return;
    }
    if (!serverId) {
      router.replace("/" as Href);
      return;
    }
    const route = await routeAfterStep("signin", serverId);
    router.replace(route as Href);
  }, [router, serverId, fromSettings]);
  const goNext = useCallback(() => void next(), [next]);

  const load = useCallback(async () => {
    setLoadError(null);
    let o: Options;
    try {
      o = await rpc<Options>(serverId, ONBOARDING_RPC.signinOptions, {});
    } catch (e) {
      setLoadError((e as Error).message);
      return;
    }
    // A host without DinoBot's setup (plain Paseo) has nothing to sign in here.
    if (!o.available) await next();
    else setOptions(o);
  }, [serverId, next, setOptions]);
  const reload = useCallback(() => void load(), [load]);
  useEffect(reload, [reload]);

  // Poll while a sign-in is going, from whichever mount of this screen is showing it.
  const pendingId = pendingSessionId(status);
  useEffect(() => {
    if (!pendingId) return undefined;
    const timer = setInterval(() => {
      rpc<SignInStatus>(serverId, ONBOARDING_RPC.signinStatus, { sessionId: pendingId })
        .then((s) => {
          if (signInMemory.get(serverId).status?.sessionId === pendingId) setStatus(s);
          return undefined;
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [serverId, pendingId, setStatus]);

  const start = useCallback(
    async (option: SignInOption, confirmed: boolean) => {
      setBusy(true);
      setInput("");
      setActionError(null);
      try {
        const s = await rpc<SignInStatus>(serverId, ONBOARDING_RPC.signinStart, {
          optionId: option.id,
          confirmed,
        });
        setStatus(s);
      } catch (e) {
        setActionError(`Sign-in did not start: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [serverId, setStatus],
  );

  const choose = useCallback(
    (option: SignInOption) => {
      if (!option.confirm) return void start(option, false);
      // Claude login: say plainly what it costs before anything starts (27 Oct). confirmDialog,
      // not Alert.alert: that one does nothing on the desktop app, so the login never started.
      const { title, body, ok } = option.confirm;
      void confirmDialog({ title, message: body, confirmLabel: ok, cancelLabel: "Choose another" })
        .then((yes) => (yes ? start(option, true) : undefined))
        .catch((e: Error) => setActionError(e.message));
    },
    [start],
  );

  const submit = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    setActionError(null);
    try {
      const s = await rpc<SignInStatus>(serverId, ONBOARDING_RPC.signinSubmit, {
        sessionId: status.sessionId,
        text: input,
      });
      setInput("");
      inputRef.current?.reset();
      setStatus(s);
    } catch (e) {
      setActionError(`Could not send it: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [serverId, status, input, setStatus]);
  const handleSubmit = useCallback(() => void submit(), [submit]);

  // From Settings with an option (e.g. right after installing a provider plugin): start that sign-in once.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!optionParam || autoStarted.current || status || !options) return;
    // The Claude Code login is not one of pi's options: the host runs `claude auth login`.
    const option =
      optionParam === CLAUDE_CODE_OPTION_ID
        ? CLAUDE_CODE_OPTION
        : options.options.find((o) => o.id === optionParam);
    autoStarted.current = true;
    if (option) choose(option);
    else setActionError("That sign-in is not offered by this computer any more. Pick one below.");
  }, [optionParam, options, status, choose]);

  // Back: stops a sign-in in progress; otherwise this is the first step (the pair screen is gone),
  // so it carries on to the next one: Choose models, which is also where its own Back came from.
  const back = useCallback(() => {
    if (status && status.state !== "done") {
      void rpc(serverId, ONBOARDING_RPC.signinCancel, { sessionId: status.sessionId }).catch(
        () => undefined,
      );
      setStatus(null);
      return;
    }
    void next();
  }, [status, serverId, next, setStatus]);

  // Several accounts are fine (e.g. a subscription plus an API key): back to the list.
  const another = useCallback(() => {
    setStatus(null);
    setOptions(null);
    void load();
  }, [load, setStatus, setOptions]);
  const chooseAgain = useCallback(() => setStatus(null), [setStatus]);

  const openAndCopy = useCallback(async () => {
    if (status?.code) await Clipboard.setStringAsync(status.code);
    if (status?.url) await Linking.openURL(status.url);
  }, [status]);
  const handleOpenAndCopy = useCallback(() => void openAndCopy(), [openAndCopy]);
  const openUrl = useCallback(() => {
    if (status?.url) void Linking.openURL(status.url);
  }, [status]);

  const contentStyle = useMemo(
    () => [styles.content, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );

  return (
    <View style={styles.container} testID="setup-signin-screen">
      <BackHeader
        title={
          packageOnly
            ? "Add a provider package"
            : optionParam === CLAUDE_CODE_OPTION_ID
              ? "Log in to Claude Code"
              : fromSettings
                ? "Add a sign-in"
                : "Sign in for your bots"
        }
        onBack={back}
      />
      <ScrollView contentContainerStyle={contentStyle} keyboardShouldPersistTaps="handled">
        {actionError ? (
          <View style={styles.card} testID="setup-signin-action-error">
            <Text style={styles.error}>{actionError}</Text>
          </View>
        ) : null}
        {packageOnly && serverId ? (
          <InstallFromLink serverId={serverId} />
        ) : status ? (
          <View style={styles.card} testID="setup-signin-session">
            <Text style={styles.title}>{status.label}</Text>
            <SessionBody
              status={status}
              input={input}
              busy={busy}
              inputRef={inputRef}
              onInput={setInput}
              onSubmit={handleSubmit}
              onContinue={goNext}
              continueLabel={fromSettings ? "Done" : "Continue"}
              onAnother={another}
              onChooseAgain={chooseAgain}
              onOpenAndCopy={handleOpenAndCopy}
              onOpenUrl={openUrl}
            />
          </View>
        ) : (
          <>
            <Text style={styles.lead}>
              {`${APP_DISPLAY_NAME}'s bots run on your computer. Pick the account they use. You sign in here; your computer keeps the sign-in.`}
            </Text>
            {options?.signedIn.length ? (
              <View style={styles.card}>
                <Text
                  style={styles.ok}
                >{`✓ Already signed in: ${options.signedIn.join(", ")}`}</Text>
                {fromSettings ? null : (
                  <Button variant="default" onPress={goNext} testID="setup-signin-skip">
                    Continue with this
                  </Button>
                )}
              </View>
            ) : null}
            <OptionsList
              options={options}
              loadError={loadError}
              busy={busy}
              onRetry={reload}
              onChoose={choose}
            />
            {fromSettings && serverId ? <InstallFromLink serverId={serverId} /> : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

interface SessionBodyProps {
  status: SignInStatus;
  input: string;
  busy: boolean;
  inputRef: RefObject<EditingTextInputHandle | null>;
  onInput: (text: string) => void;
  onSubmit: () => void;
  onContinue: () => void;
  continueLabel: string;
  onAnother: () => void;
  onChooseAgain: () => void;
  onOpenAndCopy: () => void;
  onOpenUrl: () => void;
}

/** One sign-in in progress: done, failed, or waiting (code / page / pasted code or key). */
function SessionBody(props: SessionBodyProps) {
  const { status } = props;
  if (status.state === "done") {
    return (
      <>
        <Text style={styles.ok} testID="setup-signin-done">
          {`✓ Signed in. Your computer keeps the sign-in; ${DEVICE_COPY.thisApp} never stores it.`}
        </Text>
        <Button variant="default" onPress={props.onContinue} testID="setup-signin-continue">
          {props.continueLabel}
        </Button>
        <Button onPress={props.onAnother} testID="setup-signin-another">
          Add another sign-in
        </Button>
      </>
    );
  }
  if (status.state === "error") {
    return (
      <>
        <Text style={styles.error}>{status.error ?? "Sign-in failed."}</Text>
        <Button onPress={props.onChooseAgain}>Choose again</Button>
      </>
    );
  }
  const isKey = status.prompt?.kind === "key";
  // pi's other questions can take a blank answer: GitHub Copilot asks "GitHub Enterprise
  // URL/domain (blank for github.com)", so an empty answer must be sendable (only a key needs text).
  return (
    <>
      <SessionLink
        status={status}
        onOpenAndCopy={props.onOpenAndCopy}
        onOpenUrl={props.onOpenUrl}
      />
      {status.prompt ? (
        <>
          <Text style={styles.body}>{status.prompt.message}</Text>
          <ThemedTextInput
            ref={props.inputRef}
            onChangeText={props.onInput}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={isKey}
            placeholder={isKey ? "Paste the key" : "Type or paste here"}
            style={styles.input}
            testID="setup-signin-input"
          />
          <Button
            variant="default"
            onPress={props.onSubmit}
            disabled={(isKey && !props.input.trim()) || props.busy}
            loading={props.busy}
          >
            {isKey ? "Save key" : "Continue"}
          </Button>
        </>
      ) : (
        <View style={styles.row}>
          <MutedSpinner />
          <Text style={styles.body}>
            {status.code ? "Waiting for you to approve it…" : "Working…"}
          </Text>
        </View>
      )}
    </>
  );
}

/** The device code to type in, or the sign-in page to open (copy-code logins). */
function SessionLink({
  status,
  onOpenAndCopy,
  onOpenUrl,
}: {
  status: SignInStatus;
  onOpenAndCopy: () => void;
  onOpenUrl: () => void;
}) {
  if (status.code) {
    return (
      <>
        <Text style={styles.body}>Open the page and enter this code:</Text>
        <Text style={styles.code} selectable testID="setup-signin-code">
          {status.code}
        </Text>
        <Button variant="default" onPress={onOpenAndCopy}>
          Copy code and open
        </Button>
      </>
    );
  }
  if (!status.url) return null;
  return (
    <>
      <Text style={styles.body}>
        {status.instructions ?? "Open the sign-in page, sign in, then copy the code it shows."}
      </Text>
      <Button variant="default" onPress={onOpenUrl}>
        Open sign-in page
      </Button>
    </>
  );
}

function OptionsList({
  options,
  loadError,
  busy,
  onRetry,
  onChoose,
}: {
  options: Options | null;
  loadError: string | null;
  busy: boolean;
  onRetry: () => void;
  onChoose: (option: SignInOption) => void;
}) {
  if (loadError) {
    return (
      <View style={styles.card}>
        <Text style={styles.error}>{loadError}</Text>
        <Button onPress={onRetry}>Try again</Button>
      </View>
    );
  }
  if (!options) {
    return (
      <View style={styles.row}>
        <MutedSpinner />
        <Text style={styles.body}>Asking your computer…</Text>
      </View>
    );
  }
  return (
    <>
      {options.options.map((o) => (
        <SignInOptionRow key={o.id} option={o} disabled={busy} onChoose={onChoose} />
      ))}
    </>
  );
}

/**
 * Settings only: paste a provider invite link (`<scheme>://provider/add?…`) and open it on the
 * provider-link screen, which asks this computer to install it.
 */
function InstallFromLink({ serverId }: { serverId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const invite = providerInviteFromIncoming(text, APP_LINK_SCHEME);
  const open = useCallback(() => {
    if (invite) router.push(providerLinkRoute(invite.link, serverId) as Href);
  }, [invite, router, serverId]);
  return (
    <View style={styles.card} testID="setup-signin-install-link">
      <Text style={styles.title}>Install from a link</Text>
      <Text style={styles.body}>
        {`Paste a ${APP_LINK_SCHEME}://provider/add link someone sent you. Your computer installs the provider.`}
      </Text>
      <ThemedTextInput
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={`${APP_LINK_SCHEME}://provider/add?…`}
        style={styles.input}
        testID="setup-signin-install-link-input"
      />
      {text.trim() && !invite ? (
        <Text style={styles.error}>That is not a provider link.</Text>
      ) : null}
      <Button
        variant="default"
        onPress={open}
        disabled={!invite}
        testID="setup-signin-install-link-open"
      >
        Continue
      </Button>
    </View>
  );
}

function pressableCardStyle({ pressed }: PressableStateCallbackType) {
  return [styles.card, pressed && styles.pressed];
}

/**
 * One way to sign in; the Claude login carries its badge from the host's list (EXTRA USAGE, or
 * UNOFFICIAL when the host has a provider plugin for the Claude plan), shown as a warning.
 */
function SignInOptionRow({
  option,
  disabled,
  onChoose,
}: {
  option: SignInOption;
  disabled: boolean;
  onChoose: (option: SignInOption) => void;
}) {
  const handlePress = useCallback(() => onChoose(option), [onChoose, option]);
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      style={pressableCardStyle}
      testID={`setup-signin-${option.id}`}
    >
      <View style={styles.row}>
        <Text style={styles.title}>{option.label}</Text>
        {option.badge ? (
          <Text style={badgeIsWarning(option) ? styles.badgeWarn : styles.badge}>
            {option.badge}
          </Text>
        ) : null}
      </View>
      {option.note ? <Text style={styles.body}>{option.note}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[6], gap: theme.spacing[3], ...setupColumnStyle },
  lead: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  card: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[2],
  },
  pressed: { opacity: 0.7 },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  body: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  ok: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 2,
    textAlign: "center",
    paddingVertical: theme.spacing[2],
  },
  input: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.base,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  badge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  badgeWarn: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
