import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export type PaneHost = "main" | "explorer";

export interface PanelManifest<K extends WorkspaceTabTarget["kind"] = WorkspaceTabTarget["kind"]> {
  kind: K;
  supportedHosts: readonly PaneHost[];
  showCloseButton: boolean;
  singleton: boolean;
  resourceKey(target: Extract<WorkspaceTabTarget, { kind: K }>): string;
}

type PanelManifestByKind = {
  [K in WorkspaceTabTarget["kind"]]: PanelManifest<K>;
};

const manifests = {
  agent: {
    kind: "agent",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    resourceKey: (target) => target.agentId,
  },
  provider_subagent: {
    kind: "provider_subagent",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    resourceKey: (target) => `${target.parentAgentId}:${target.subagentId}`,
  },
  files: {
    kind: "files",
    supportedHosts: ["explorer"],
    showCloseButton: false,
    singleton: true,
    resourceKey: () => "files",
  },
  network_status: {
    kind: "network_status",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: true,
    resourceKey: () => "network_status",
  },
  file: {
    kind: "file",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    resourceKey: (target) => target.path,
  },
  plugin: {
    kind: "plugin",
    // Plugin targets are narrowed by the target-aware plugin panel capability resolver.
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    resourceKey: (target) =>
      target.context === "agent"
        ? `${target.pluginId}:${target.panelId}:agent:${target.agentId}`
        : `${target.pluginId}:${target.panelId}:workspace`,
  },
} satisfies PanelManifestByKind;

export function getPanelManifest<K extends WorkspaceTabTarget["kind"]>(kind: K): PanelManifest<K> {
  return manifests[kind] as unknown as PanelManifest<K>;
}

export function panelSupportsHost(kind: WorkspaceTabTarget["kind"], host: PaneHost): boolean {
  return getPanelManifest(kind).supportedHosts.includes(host);
}

export function panelCanLaunchInPane(
  kind: WorkspaceTabTarget["kind"],
  panePanelKinds: readonly WorkspaceTabTarget["kind"][],
): boolean {
  return !getPanelManifest(kind).singleton || !panePanelKinds.includes(kind);
}

export function panelResourceKey(target: WorkspaceTabTarget): string {
  const manifest = getPanelManifest(target.kind);
  return `${target.kind}:${manifest.resourceKey(target as never)}`;
}
