import { Activity } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { ExplorerNetworkTab } from "@/components/explorer-network-tab";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const ThemedActivity = withUnistyles(Activity);
const networkPanelPresentation = {
  label: (t) => t("network.tabLabel"),
  subtitle: (t) => t("network.panelSubtitle"),
  tooltip: (t) => t("network.panelTooltip"),
  icon: ThemedActivity,
} satisfies PanelPresentation;

function NetworkPanel() {
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "network_status", "NetworkPanel requires network_status target");
  return <ExplorerNetworkTab serverId={serverId} />;
}

export const networkPanelRegistration = definePanel("network_status", {
  component: NetworkPanel,
  presentation: networkPanelPresentation,
});
