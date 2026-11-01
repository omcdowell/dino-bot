import { useCallback } from "react";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { useHostRuntimeBootstrapState } from "@/app/_layout";
import { HostRouteProvider } from "@/navigation/host-route-context";
import { resolveStartupRoute } from "@/navigation/host-runtime-bootstrap";
import { ThemedStack } from "@/navigation/themed-stack";
import { useHostRegistryStatus, useHosts } from "@/runtime/host-runtime";
import { pluginScreenOptions, workspaceScreenOptions } from "@/navigation/mobile-home-stack";
import { isInstalledPluginChatScreen, useMobileHome } from "@/plugins/mobile-home-runtime";

const HOST_STACK_SCREEN_OPTIONS = {
  headerShown: false,
  animation: "none" as const,
};

const AGENT_SCREEN_OPTIONS = { gestureEnabled: false };

export default function HostRouteLayout() {
  return <KnownHostRoute />;
}

function KnownHostRoute() {
  const params = useLocalSearchParams<{ serverId?: string | string[] }>();
  const hosts = useHosts();
  const hostRegistryStatus = useHostRegistryStatus();
  const bootstrapState = useHostRuntimeBootstrapState();
  const routeServerId = typeof params.serverId === "string" ? params.serverId : null;
  // Phones: a chat pushed from the home slides in and swipes back natively (see mobile-home-stack).
  const mobileHome = useMobileHome();
  const homeHere = mobileHome && mobileHome.serverId === routeServerId ? mobileHome : null;
  const workspaceOptions = useCallback(
    ({ route, navigation }: { route: { key: string }; navigation: { getState(): unknown } }) =>
      workspaceScreenOptions({
        stackState: navigation.getState(),
        routeKey: route.key,
        home: homeHere,
      }),
    [homeHere],
  );
  // A plugin screen that opens like a chat (e.g. a group thread) gets the same push over the home.
  const pluginOptions = useCallback(
    ({ route, navigation }: { route: { key: string }; navigation: { getState(): unknown } }) =>
      pluginScreenOptions({
        stackState: navigation.getState(),
        routeKey: route.key,
        home: homeHere,
        isPluginChatScreen: isInstalledPluginChatScreen,
      }),
    [homeHere],
  );
  const startupRoute = resolveStartupRoute({
    route: { kind: "host", serverId: routeServerId },
    startupBlocker: bootstrapState.startupBlocker,
    hostRegistryStatus,
    hosts,
  });

  if (startupRoute.kind === "redirect") {
    return <Redirect href={startupRoute.href} />;
  }

  const stack = (
    <ThemedStack screenOptions={HOST_STACK_SCREEN_OPTIONS}>
      <Stack.Screen name="index" />
      <Stack.Screen name="workspace/[workspaceId]/index" options={workspaceOptions} />
      <Stack.Screen name="agent/[agentId]" options={AGENT_SCREEN_OPTIONS} />
      <Stack.Screen name="sessions" />
      <Stack.Screen name="open-project" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="plugin/[pluginId]/[surfaceId]" />
      <Stack.Screen
        name="plugin/[pluginId]/[contributionKind]/[contributionId]"
        options={pluginOptions}
      />
    </ThemedStack>
  );

  if (!routeServerId) {
    return stack;
  }

  return <HostRouteProvider serverId={routeServerId}>{stack}</HostRouteProvider>;
}
