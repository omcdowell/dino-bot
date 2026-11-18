import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { i18n } from "@/i18n/i18next";

export interface BulkClosableTabGroups {
  archiveAgentTabs: Array<{ tabId: string; agentId: string }>;
  layoutOnlyAgentTabs: Array<{ tabId: string; agentId: string }>;
  otherTabs: Array<{ tabId: string; target: WorkspaceTabDescriptor["target"] }>;
}

export interface BulkCloseConfirmationLabels {
  agentsAndTabs: (input: { agents: number; tabs: number }) => string;
  tabs: (input: { tabs: number }) => string;
  agents: (input: { agents: number }) => string;
}

export const DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS: BulkCloseConfirmationLabels = {
  agentsAndTabs: ({ agents, tabs }) =>
    `This will archive ${agents} agent(s) and close ${tabs} tab(s).`,
  tabs: ({ tabs }) => `This will close ${tabs} tab(s).`,
  agents: ({ agents }) => `This will archive ${agents} agent(s).`,
};

interface CloseWorkspaceTabWithCleanupInput {
  tabId: string;
  target?: WorkspaceTabDescriptor["target"];
}

interface CloseBulkWorkspaceTabsInput {
  client: Pick<DaemonClient, "closeItems"> | null;
  groups: BulkClosableTabGroups;
  closeTab: (tabId: string, action: () => Promise<void>) => Promise<void>;
  closeWorkspaceTabWithCleanup: (input: CloseWorkspaceTabWithCleanupInput) => void;
  closeLayoutOnlyAgent: (agentId: string) => Promise<void>;
  logLabel: string;
  warn?: (message: string, payload: object) => void;
}

export function classifyBulkClosableTabs(
  tabs: WorkspaceTabDescriptor[],
  resolveAgentCloseKind: (agentId: string) => "archive" | "layout-only" = () => "archive",
): BulkClosableTabGroups {
  const groups: BulkClosableTabGroups = {
    archiveAgentTabs: [],
    layoutOnlyAgentTabs: [],
    otherTabs: [],
  };

  for (const tab of tabs) {
    if (tab.target.kind === "agent") {
      const agentTab = { tabId: tab.tabId, agentId: tab.target.agentId };
      if (resolveAgentCloseKind(tab.target.agentId) === "layout-only") {
        groups.layoutOnlyAgentTabs.push(agentTab);
      } else {
        groups.archiveAgentTabs.push(agentTab);
      }
      continue;
    }
    groups.otherTabs.push({ tabId: tab.tabId, target: tab.target });
  }

  return groups;
}

export function buildBulkCloseConfirmationMessage(
  input: BulkClosableTabGroups,
  labels: BulkCloseConfirmationLabels = DEFAULT_BULK_CLOSE_CONFIRMATION_LABELS,
): string {
  const { archiveAgentTabs, layoutOnlyAgentTabs, otherTabs } = input;
  const tabCount = layoutOnlyAgentTabs.length + otherTabs.length;
  if (archiveAgentTabs.length > 0 && tabCount > 0) {
    return labels.agentsAndTabs({
      agents: archiveAgentTabs.length,
      tabs: tabCount,
    });
  }
  if (tabCount > 0) {
    return labels.tabs({ tabs: tabCount });
  }
  return labels.agents({ agents: archiveAgentTabs.length });
}

export async function closeBulkWorkspaceTabs(input: CloseBulkWorkspaceTabsInput): Promise<void> {
  const {
    client,
    groups,
    closeTab,
    closeWorkspaceTabWithCleanup,
    closeLayoutOnlyAgent,
    logLabel,
    warn,
  } = input;
  const hasDestructiveTabs = groups.archiveAgentTabs.length > 0;

  for (const { tabId, agentId } of groups.layoutOnlyAgentTabs) {
    await closeTab(tabId, async () => {
      try {
        await closeLayoutOnlyAgent(agentId);
      } catch (error) {
        warn?.(`[WorkspaceScreen] Failed to close subagent tab ${logLabel}`, { error, agentId });
        return;
      }
      closeWorkspaceTabWithCleanup({
        tabId,
        target: { kind: "agent", agentId },
      });
    });
  }

  if (hasDestructiveTabs && client) {
    void client
      .closeItems({
        agentIds: groups.archiveAgentTabs.map((tab) => tab.agentId),
      })
      .catch((error) => {
        warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, { error });
      });
  } else if (hasDestructiveTabs) {
    warn?.(`[WorkspaceScreen] Failed to bulk close tabs ${logLabel}`, {
      error: new Error(i18n.t("common.errors.daemonClientUnavailable")),
    });
  }

  await Promise.all([
    ...groups.archiveAgentTabs.map(({ tabId, agentId }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({
          tabId,
          target: { kind: "agent", agentId },
        });
      }),
    ),
    ...groups.otherTabs.map(({ tabId, target }) =>
      closeTab(tabId, async () => {
        closeWorkspaceTabWithCleanup({ tabId, target });
      }),
    ),
  ]);
}
