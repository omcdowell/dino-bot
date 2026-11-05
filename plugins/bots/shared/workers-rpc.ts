import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One herdr worker a bot launched (registry) or appears to own (inferred). See server/workers.ts. */
export const WorkerViewSchema = z.object({
  worker: z.string(),
  pane: z.string().nullable(),
  since: z.string().nullable(),
  state: z.enum(["running", "blocked", "stalled", "finished", "unknown"]),
  herdr: z.string(),
  source: z.enum(["registry", "inferred"]),
  reason: z.enum(["reported", "done", "gone", "idle", "expired"]).optional(),
  /** Stalled workers: the error it stopped on (pi session, else pane output). */
  error: z
    .object({ message: z.string(), at: z.string().nullable(), source: z.enum(["session", "pane"]) })
    .optional(),
});
export type WorkerViewDto = z.infer<typeof WorkerViewSchema>;

export const botsWorkersRpc = defineRpc({
  name: "bots.workers",
  input: z.object({}),
  output: z.object({
    bots: z.array(z.object({ botId: z.string(), workers: z.array(WorkerViewSchema) })),
    herdr: z.enum(["ok", "unavailable"]),
  }),
});

/** Workers that keep a bot "waiting": running or blocked. */
export function outstandingCount(workers: readonly Pick<WorkerViewDto, "state">[] | undefined): number {
  return (workers ?? []).filter((w) => w.state === "running" || w.state === "blocked").length;
}

/** Workers that stopped on an error without reporting (bot row shows "stalled"). */
export function stalledCount(workers: readonly Pick<WorkerViewDto, "state">[] | undefined): number {
  return (workers ?? []).filter((w) => w.state === "stalled").length;
}

export const WORKERS_POLL_MS = 10_000;
