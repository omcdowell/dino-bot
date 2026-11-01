import type { PluginAgentSnapshot } from "@getpaseo/plugin";

/**
 * What a bot row shows about the bot's chat with the owner (DMs are not tracked here).
 *
 * - none:      the bot has no chat yet.
 * - needs-you: a permission prompt is waiting for the owner.
 * - error:     the chat is in error.
 * - working:   the bot is running a turn.
 * - stalled:   idle, and a herdr worker it launched stopped on an error without reporting
 *              (server/worker-errors.ts). Red dot with the number of such workers. The bot gets
 *              one system DM about it, which usually turns the row back to working.
 * - unread:    idle, and it replied since the owner last looked (Paseo's "finished" attention flag),
 *              unless only bot DMs started the turns behind the flag (`dmOnly`, see
 *              server/dm-turns.ts): then the row falls through to waiting or read.
 * - waiting:   idle and read, but herdr workers it launched are still running.
 * - read:      idle, the owner has seen its latest reply, nothing outstanding.
 */
export type BotStatus = "none" | "working" | "stalled" | "waiting" | "unread" | "read" | "needs-you" | "error";

/**
 * Priority: needs-you > error > working > stalled > unread > waiting > read. Needs-you: an open permission
 * prompt (`pendingPermissionCount`, Paseo builds with the phone home; older hosts leave it out) or
 * a permission attention flag.
 */
export function botStatus(
  agent:
    | (Pick<PluginAgentSnapshot, "status" | "requiresAttention" | "attentionReason"> & {
        pendingPermissionCount?: number;
      })
    | null,
  outstandingWorkers = 0,
  /** The "finished" flag is owed only to DM-started turns: no green dot. */
  dmOnly = false,
  /** Workers that stopped on an error without reporting. */
  stalledWorkers = 0,
): BotStatus {
  if (!agent) return "none";
  if ((agent.pendingPermissionCount ?? 0) > 0) return "needs-you";
  if (agent.requiresAttention && agent.attentionReason === "permission") return "needs-you";
  if (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error")) return "error";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (stalledWorkers > 0) return "stalled";
  if (agent.requiresAttention && !(dmOnly && agent.attentionReason === "finished")) return "unread";
  if (outstandingWorkers > 0) return "waiting";
  return "read";
}

/**
 * Whether a server answer about DM-only turns may be applied: only if it was fetched after the
 * row's flag last switched on, so a stale "quiet" never hides a newer reply to the owner.
 */
export function quietApplies(quietIds: ReadonlySet<string>, agentId: string | null, fetchedAt: number, flagOnSince: number): boolean {
  return agentId !== null && quietIds.has(agentId) && fetchedAt > flagOnSince;
}

/**
 * The worker count is shown beside the dot whenever the bot is idle with workers still out. For
 * "stalled", the count passed is the number of stalled workers (see `rowWorkerCount`).
 */
export function showWorkerCount(status: BotStatus, outstandingWorkers: number): boolean {
  return outstandingWorkers > 0 && (status === "waiting" || status === "unread" || status === "stalled");
}

/** The number a row shows beside its dot: stalled workers when stalled, else outstanding ones. */
export function rowWorkerCount(status: BotStatus, outstandingWorkers: number, stalledWorkers: number): number {
  return status === "stalled" ? stalledWorkers : outstandingWorkers;
}

export const STATUS_LABEL: Record<BotStatus, string> = {
  none: "",
  working: "Working",
  stalled: "Worker stopped on an error",
  waiting: "Waiting for workers",
  unread: "New reply",
  read: "",
  "needs-you": "Needs you",
  error: "Error",
};

/** Accessibility text for a row's indicator, e.g. "New reply, 2 workers running". */
export function statusText(status: BotStatus, outstandingWorkers: number): string {
  if (status === "stalled") {
    return outstandingWorkers > 1 ? `${outstandingWorkers} workers stopped on an error` : STATUS_LABEL.stalled;
  }
  const base = STATUS_LABEL[status] || (status === "read" ? "Read" : "");
  if (!showWorkerCount(status, outstandingWorkers) || status === "waiting") {
    return status === "waiting" ? `${base}: ${outstandingWorkers} running` : base;
  }
  return `${base}, ${outstandingWorkers} worker${outstandingWorkers === 1 ? "" : "s"} running`;
}
