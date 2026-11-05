import { router, useLocalSearchParams } from "expo-router";
import type {
  PluginScreenFloatingHeader,
  PluginScreenParams,
  PluginScreenProps,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, type ComponentType } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HostFilter } from "@/components/hosts/host-filter";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getHostRuntimeStore, useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { usePluginHostNavigation } from "./host-navigation";
import { resolvePluginIcon } from "./icons";
import { toPluginTheme } from "./theme";
import { useInstalledPlugin, usePluginInstallations } from "./registry";
import { buildPluginSurfaceRoute, pluginScreenParamsFromRoute } from "./routes";
import {
  legacySidebarItemHostKey,
  pluginScreensHostKey,
  rememberPluginContributionHost,
} from "./contribution-host";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { PluginInstallationProvider } from "./installation-provider";
import {
  getPluginSurfaceContributionServerIds,
  resolvePluginScreenTitle,
  resolvePluginSurfaceContribution,
  type PluginSurfaceContributionIdentity,
} from "./surface-contribution";
import { resolvePluginPlatform } from "./platform";
import { createPluginClientStateSource } from "./client-state/source";
import { forgetMobileHome, useMobileHome, useStartHome } from "./mobile-home-runtime";
import { pluginRegistry } from "./registry";
import { DesktopHomeMenu, MobileHomeTopBar } from "@/components/mobile-home/home-top-bar";
import { MobileHomeTopFade, useHomeFadeLayer } from "@/components/mobile-home/home-top-fade";
import { PluginScrollTopInsetProvider } from "./react-native/scroll-top-inset";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import {
  MobileFloatingHeader,
  MobileFloatingHeaderTitle,
  mobileFloatingHeaderCircleButtonStyle,
} from "@/screens/workspace/mobile-floating-header-chrome";
import { resolveMobileFloatingHeaderInset } from "@/screens/workspace/mobile-floating-header-model";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { buildHostOpenProjectRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";

const EMPTY_SHORTCUT_KEYS: ShortcutKey[] = [];
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pluginThemeMapping = (theme: Theme) => ({
  theme: toPluginTheme(theme),
});
const ThemedX = withUnistyles(X);

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function PluginHeaderIcon({
  Icon,
  color = "",
}: {
  Icon: ReturnType<typeof resolvePluginIcon>;
  color?: string;
}) {
  return <Icon size={16} color={color} />;
}

const ThemedPluginHeaderIcon = withUnistyles(PluginHeaderIcon);

function SurfaceRenderer({
  Surface,
  plugin,
  layout,
  host,
  params,
  theme,
  floatingHeaderInset,
}: {
  Surface: ComponentType<PluginScreenProps>;
  plugin: NonNullable<ReturnType<typeof useInstalledPlugin>>;
  layout: PluginScreenProps["layout"];
  host: PluginScreenProps["host"];
  params: PluginScreenParams;
  theme: PluginTheme;
  floatingHeaderInset?: number;
}) {
  const navigation = usePluginHostNavigation(host.id);
  // The host's agent and workspace directory syncs on demand (the sidebar and workspace screens ask
  // for it). A screen may be all there is, e.g. the phone home, so it asks too.
  useEffect(() => getHostRuntimeStore().acquireDirectoryDemand(host.id), [host.id]);
  // Screens read live agent state (`useAgent`) like panels and sidebar items do.
  const stateSource = useMemo(() => createPluginClientStateSource(host.id), [host.id]);
  return (
    <PluginInstallationProvider plugin={plugin}>
      <PluginClientStateProvider source={stateSource}>
        <Surface
          theme={theme}
          host={host}
          layout={layout}
          navigation={navigation}
          params={params}
          {...(floatingHeaderInset === undefined ? {} : { floatingHeaderInset })}
        />
      </PluginClientStateProvider>
    </PluginInstallationProvider>
  );
}

const ThemedSurfaceRenderer = withUnistyles(SurfaceRenderer);

function PluginHostFilter({
  serverId,
  pluginId,
  identity,
  params,
  serverIds,
}: {
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity;
  params: PluginScreenParams;
  serverIds: string[];
}) {
  const allHosts = useHosts();
  const hosts = useMemo(
    () => allHosts.filter((host) => serverIds.includes(host.serverId)),
    [allHosts, serverIds],
  );
  const selectHost = useCallback(
    (nextServerId: string) => {
      // A legacy row remembers its own host; a screen's host carries to all the plugin's items.
      rememberPluginContributionHost(
        identity.kind === "sidebar"
          ? legacySidebarItemHostKey(pluginId, identity.id)
          : pluginScreensHostKey(pluginId),
        nextServerId,
      );
      router.replace(buildPluginSurfaceRoute(nextServerId, pluginId, identity, params));
    },
    [identity, params, pluginId],
  );
  const show = serverIds.length > 1 && hosts.length > 1;
  if (!show) return null;

  return (
    <HostFilter
      hosts={hosts}
      selectedHost={serverId}
      onSelectHost={selectHost}
      includeAllHost={false}
      triggerTestID="plugin-host-filter-trigger"
    />
  );
}

/** A phone home installed from the device cache renders before the host has a client. */
function canShowSurface(
  plugin: { source?: "live" | "cache" } | null,
  surface: unknown,
  client: unknown,
): boolean {
  if (!plugin || !surface) return false;
  return Boolean(client) || plugin.source === "cache";
}

export function PluginSurfaceScreen() {
  const routeParams = useLocalSearchParams<{
    serverId?: string | string[];
    pluginId?: string | string[];
    contributionKind?: string | string[];
    contributionId?: string | string[];
  }>();
  const serverId = routeParam(routeParams.serverId);
  const pluginId = routeParam(routeParams.pluginId);
  const contributionKind = routeParam(routeParams.contributionKind);
  const contributionId = routeParam(routeParams.contributionId);
  const paramsKey = JSON.stringify(pluginScreenParamsFromRoute(routeParams));
  // Keyed by content: the route hands back a new object on every render.
  const params = useMemo<PluginScreenParams>(() => JSON.parse(paramsKey), [paramsKey]);
  const identity = useMemo<PluginSurfaceContributionIdentity | null>(() => {
    if (contributionKind !== "sidebar" && contributionKind !== "surface") return null;
    return { kind: contributionKind, id: contributionId };
  }, [contributionId, contributionKind]);
  const plugin = useInstalledPlugin(serverId, pluginId);
  const installations = usePluginInstallations(pluginId);
  const hosts = useHosts();
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const { sidebarItem, surface } = useMemo(
    () => resolvePluginSurfaceContribution(plugin, identity),
    [identity, plugin],
  );
  const showSurface = canShowSurface(plugin, surface, client);
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const contributionServerIds = useMemo(
    () =>
      identity ? getPluginSurfaceContributionServerIds(installations, pluginId, identity) : [],
    [identity, installations, pluginId],
  );
  const title = useMemo(
    () =>
      surface
        ? resolvePluginScreenTitle(surface, sidebarItem, params)
        : (sidebarItem?.title ?? (pluginId || "Plugin")),
    [params, pluginId, sidebarItem, surface],
  );
  const Icon = sidebarItem ? resolvePluginIcon(sidebarItem.icon) : null;
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/h/${encodeURIComponent(serverId)}`);
  }, [serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const headerLeft = useMemo(
    () => (
      <>
        {Icon ? (
          <HeaderIconBadge>
            <ThemedPluginHeaderIcon Icon={Icon} uniProps={mutedColorMapping} />
          </HeaderIconBadge>
        ) : null}
        <ScreenTitle testID="plugin-surface-title">{title}</ScreenTitle>
      </>
    ),
    [Icon, title],
  );
  const headerRight = useMemo(
    () => (
      <>
        {identity ? (
          <PluginHostFilter
            serverId={serverId}
            pluginId={pluginId}
            identity={identity}
            params={params}
            serverIds={contributionServerIds}
          />
        ) : null}
        <HeaderToggleButton
          accessibilityLabel="Close plugin"
          onPress={close}
          testID="plugin-surface-close"
          tooltipKeys={EMPTY_SHORTCUT_KEYS}
          tooltipLabel="Close"
          tooltipSide="bottom"
        >
          <ThemedX size={18} uniProps={mutedColorMapping} />
        </HeaderToggleButton>
      </>
    ),
    [close, contributionServerIds, identity, params, pluginId, serverId],
  );

  const { headerless, awaitingHome, desktopHome } = useMobileHomeSurface({
    serverId,
    pluginId,
    identity,
    surface,
    ready: showSurface,
  });

  // The desktop start home: the plugin's "⋯" menu (New bot, New group chat…) instead of Close.
  const homeMenu = surface?.mobileHomeMenu;
  const screenHeaderRight = useMemo(
    () =>
      desktopHome ? <DesktopHomeMenu serverId={serverId} pluginMenu={homeMenu} /> : headerRight,
    [desktopHome, headerRight, homeMenu, serverId],
  );

  // The phone home's content runs under its floating top bar and fade, starting below the fade.
  const homeFade = useHomeFadeLayer();
  const { headerBar, floatingHeader, floatingHeaderInset, scrollTopInset } = useScreenChrome({
    compact,
    headerless,
    awaitingHome,
    surface,
    homeInsetTop: homeFade.contentInsetTop,
  });
  const errorTextStyle = useMemo(
    () => [styles.errorText, { paddingTop: scrollTopInset }],
    [scrollTopInset],
  );

  return (
    <View style={styles.screen}>
      {headerBar ? <ScreenHeader left={headerLeft} right={screenHeaderRight} /> : null}
      <View style={styles.body}>
        {awaitingHome ? <MobileHomeLoading serverId={serverId} /> : null}
        {showSurface && plugin && surface && !awaitingHome ? (
          <PluginScrollTopInsetProvider value={scrollTopInset}>
            <SurfaceErrorBoundary
              key={`${serverId}/${pluginId}/${identity?.kind}/${contributionId}`}
              installation={plugin}
              Surface={surface.Component}
            >
              <ThemedSurfaceRenderer
                Surface={surface.Component}
                plugin={plugin}
                host={host}
                layout={layout}
                params={params}
                floatingHeaderInset={floatingHeaderInset}
                uniProps={pluginThemeMapping}
              />
            </SurfaceErrorBoundary>
          </PluginScrollTopInsetProvider>
        ) : null}
        <PluginFloatingHeader
          config={floatingHeader}
          title={title}
          plugin={showSurface ? plugin : null}
          host={host}
          layout={layout}
          params={params}
          floatingHeaderInset={floatingHeaderInset}
        />
        {!awaitingHome && !showSurface ? (
          <Text style={errorTextStyle}>
            {plugin && surface ? "Plugin host is offline." : "This plugin surface is unavailable."}
          </Text>
        ) : null}
        {headerless ? <MobileHomeTopFade /> : null}
        {headerless ? (
          <MobileHomeTopBar serverId={serverId} pluginMenu={surface?.mobileHomeMenu} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * What the screen draws at its top. The phone home: its own top bar (see useMobileHomeSurface). A
 * screen that opens like a chat (`mobileFloatingHeader`) on phones: the bot chat's floating header,
 * with its content running under it like the chat's. Anything else: the header bar.
 */
function useScreenChrome(input: {
  compact: boolean;
  headerless: boolean;
  awaitingHome: boolean;
  surface: { mobileFloatingHeader?: PluginScreenFloatingHeader } | null;
  homeInsetTop: number;
}): {
  headerBar: boolean;
  floatingHeader: PluginScreenFloatingHeader | null;
  floatingHeaderInset: number | undefined;
  scrollTopInset: number;
} {
  const safeAreaInsets = useSafeAreaInsets();
  if (input.headerless) {
    return {
      headerBar: false,
      floatingHeader: null,
      floatingHeaderInset: undefined,
      scrollTopInset: input.homeInsetTop,
    };
  }
  const floatingHeader =
    input.compact && !input.awaitingHome ? (input.surface?.mobileFloatingHeader ?? null) : null;
  if (!floatingHeader) {
    return {
      headerBar: true,
      floatingHeader: null,
      floatingHeaderInset: undefined,
      scrollTopInset: 0,
    };
  }
  const inset = resolveMobileFloatingHeaderInset(safeAreaInsets.top);
  return { headerBar: false, floatingHeader, floatingHeaderInset: inset, scrollTopInset: inset };
}

/**
 * The bot chat's floating header (option D) for a plugin screen registered with
 * `mobileFloatingHeader`: back (or the menu without a phone home) · [plugin avatar + title] ····
 * [plugin controls]. The plugin's parts render like the screen itself (same props and providers),
 * once the screen can show; if one throws it is left out rather than taking the screen down.
 */
function PluginFloatingHeader({
  config,
  title,
  plugin,
  host,
  layout,
  params,
  floatingHeaderInset,
}: {
  config: PluginScreenFloatingHeader | null;
  title: string;
  plugin: ReturnType<typeof useInstalledPlugin>;
  host: PluginScreenProps["host"];
  layout: PluginScreenProps["layout"];
  params: PluginScreenParams;
  floatingHeaderInset: number | undefined;
}) {
  const leading = useMemo(
    () => <SidebarMenuToggle style={mobileFloatingHeaderCircleButtonStyle} />,
    [],
  );
  const parts = useMemo(() => {
    const render = (Part: ComponentType<PluginScreenProps> | undefined) =>
      Part && plugin ? (
        <SurfaceErrorBoundary installation={plugin} Surface={Part} renderError={renderNothing}>
          <ThemedSurfaceRenderer
            Surface={Part}
            plugin={plugin}
            host={host}
            layout={layout}
            params={params}
            floatingHeaderInset={floatingHeaderInset}
            uniProps={pluginThemeMapping}
          />
        </SurfaceErrorBoundary>
      ) : null;
    return { avatar: render(config?.Avatar), controls: render(config?.Controls) };
  }, [config, floatingHeaderInset, host, layout, params, plugin]);
  const identity = useMemo(
    () => <MobileFloatingHeaderTitle title={title} avatar={parts.avatar} />,
    [parts.avatar, title],
  );
  if (!config) return null;
  return <MobileFloatingHeader leading={leading} identity={identity} controls={parts.controls} />;
}

function renderNothing() {
  return null;
}

/**
 * The phone home (a `mobileHome` screen) renders with its own top bar instead of the host header,
 * and waits for plugins to load instead of showing "unavailable" when the start redirect got there
 * first.
 */
function useMobileHomeSurface(input: {
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity | null;
  surface: { mobileHome?: boolean } | null;
  ready: boolean;
}): { headerless: boolean; awaitingHome: boolean; desktopHome: boolean } {
  // The phone home, or the DinoBot desktop app's start home (the same screen, with the normal
  // header bar and its "⋯" menu instead of Close).
  const phoneHome = useMobileHome();
  const startHome = useStartHome();
  const isHomeRoute =
    input.identity?.kind === "surface" &&
    startHome?.serverId === input.serverId &&
    startHome.pluginId === input.pluginId &&
    startHome.screenId === input.identity.id;
  // Stays true if the home goes away under this screen, so it can still leave for the workspace.
  const wasHomeRoute = useRef(false);
  if (isHomeRoute) wasHomeRoute.current = true;
  if (!wasHomeRoute.current) return { headerless: false, awaitingHome: false, desktopHome: false };
  const isMobileHomeSurface = input.surface ? input.surface.mobileHome === true : true;
  return {
    headerless: phoneHome !== null && isMobileHomeSurface,
    awaitingHome: !input.ready,
    desktopHome: phoneHome === null && isMobileHomeSurface,
  };
}

/**
 * The start redirect opened the remembered home before plugins loaded. Wait for them; if the host
 * is connected and its catalog came without the home, forget it and go to the last workspace.
 */
function MobileHomeLoading({ serverId }: { serverId: string }) {
  const connected = useHostRuntimeIsConnected(serverId);
  // Re-rendered by the parent on every registry change.
  const hasCatalog = pluginRegistry.hasCatalog(serverId);
  const lastWorkspace = useLastWorkspaceSelection();
  const gone = connected && hasCatalog;
  useEffect(() => {
    if (!gone) return;
    forgetMobileHome();
    router.replace(
      lastWorkspace
        ? buildHostWorkspaceRoute(lastWorkspace.serverId, lastWorkspace.workspaceId)
        : buildHostOpenProjectRoute(serverId),
    );
  }, [gone, lastWorkspace, serverId]);
  return (
    <View style={styles.loading} testID="mobile-home-loading">
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
  },
  errorText: {
    color: theme.colors.statusDanger,
    padding: theme.spacing[4],
  },
}));
