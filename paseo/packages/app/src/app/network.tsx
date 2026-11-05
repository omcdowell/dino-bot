import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { NetworkStatusPage } from "@/screens/network-status/network-status-page";

/** Full-screen Network page, for screens without an Explorer (and the fault banner there). */
export default function NetworkRoute() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : null;
  return (
    <HostRouteBootstrapBoundary>
      <View style={styles.container}>
        <BackHeader title={t("network.title")} />
        <NetworkStatusPage focusServerId={serverId} />
      </View>
    </HostRouteBootstrapBoundary>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
