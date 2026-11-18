import { agentPanelRegistration } from "@/panels/agent-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { filesPanelRegistration } from "@/panels/files-panel";
import { registerPanel } from "@/panels/panel-registry";
import { providerSubagentPanelRegistration } from "@/panels/provider-subagent-panel";
import { networkPanelRegistration } from "@/panels/network-panel";
import { pluginPanelRegistration } from "@/plugins/workspace-panels/panel";

let panelsRegistered = false;

export function ensurePanelsRegistered(): void {
  if (panelsRegistered) {
    return;
  }
  registerPanel(agentPanelRegistration);
  registerPanel(providerSubagentPanelRegistration);
  registerPanel(filePanelRegistration);
  registerPanel(filesPanelRegistration);
  registerPanel(networkPanelRegistration);
  registerPanel(pluginPanelRegistration);
  panelsRegistered = true;
}
