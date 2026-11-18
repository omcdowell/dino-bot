import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

/**
 * Pending permission structure
 * Uses the protocol permission types
 */
export interface PendingPermission {
  key: string;
  agentId: string;
  request: AgentPermissionRequest;
}

// Agent info interface is provided by SessionContext's Agent type
