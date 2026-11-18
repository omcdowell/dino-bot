import { normalizeWorkspaceFileLocation, workspaceFileLocationsEqual } from "@/workspace/file-open";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

// Persisted layouts may still hold tab kinds that no longer exist (draft, terminal, browser,
// diff, PR, setup). Those normalize to null and are dropped.
export function normalizeWorkspaceTabTarget(
  value: WorkspaceTabTarget | null | undefined,
): WorkspaceTabTarget | null {
  if (!value || typeof value !== "object" || typeof value.kind !== "string") {
    return null;
  }
  switch (value.kind) {
    case "agent": {
      const agentId = trimNonEmpty(value.agentId);
      return agentId ? { kind: "agent", agentId } : null;
    }
    case "provider_subagent": {
      const parentAgentId = trimNonEmpty(value.parentAgentId);
      const subagentId = trimNonEmpty(value.subagentId);
      return parentAgentId && subagentId
        ? { kind: "provider_subagent", parentAgentId, subagentId }
        : null;
    }
    case "file":
      return normalizeFileTabTarget(value);
    case "plugin":
      return normalizePluginTabTarget(value);
    case "files":
    case "network_status":
      return { kind: value.kind };
    default:
      return null;
  }
}

export function workspaceTabTargetsEqual(
  left: WorkspaceTabTarget,
  right: WorkspaceTabTarget,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "agent" && right.kind === "agent") {
    return left.agentId === right.agentId;
  }
  if (left.kind === "provider_subagent" && right.kind === "provider_subagent") {
    return left.parentAgentId === right.parentAgentId && left.subagentId === right.subagentId;
  }
  if (left.kind === "plugin" && right.kind === "plugin") {
    return (
      left.pluginId === right.pluginId &&
      left.panelId === right.panelId &&
      left.context === right.context &&
      (left.context === "workspace" ||
        (right.context === "agent" && left.agentId === right.agentId))
    );
  }
  if (left.kind === "file" && right.kind === "file") {
    return workspaceFileLocationsEqual(left, right);
  }
  return left.kind === "files" || left.kind === "network_status";
}

export function buildDeterministicWorkspaceTabId(target: WorkspaceTabTarget): string {
  if (target.kind === "agent") {
    return `agent_${target.agentId}`;
  }
  if (target.kind === "provider_subagent") {
    return `provider_subagent_${target.parentAgentId.length}_${target.parentAgentId}_${target.subagentId.length}_${target.subagentId}`;
  }
  if (target.kind === "files" || target.kind === "network_status") {
    return target.kind;
  }
  if (target.kind === "plugin") {
    const identity = `${target.pluginId.length}_${target.pluginId}_${target.panelId.length}_${target.panelId}`;
    return target.context === "workspace"
      ? `plugin_workspace_${identity}`
      : `plugin_agent_${identity}_${target.agentId.length}_${target.agentId}`;
  }
  return `file_${target.path}`;
}

function normalizePluginTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "plugin" }>,
): WorkspaceTabTarget | null {
  const pluginId = trimNonEmpty(value.pluginId);
  const panelId = trimNonEmpty(value.panelId);
  if (!pluginId || !panelId) return null;
  if (value.context === "workspace") {
    return { kind: "plugin", pluginId, panelId, context: "workspace" };
  }
  const agentId = trimNonEmpty(value.agentId);
  return agentId ? { kind: "plugin", pluginId, panelId, context: "agent", agentId } : null;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFileTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "file" }>,
): WorkspaceTabTarget | null {
  const location = normalizeWorkspaceFileLocation(value);
  return location ? { kind: "file", ...location } : null;
}
