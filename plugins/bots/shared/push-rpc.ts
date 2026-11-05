import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Bots-home data pushed instead of polled (Paseo hosts with plugin events, `server.emit`).
 * The server recomputes each kind every PUSH_CHECK_MS while someone is watching and emits
 * `bots.<kind>` with `{ rev, data }` (data = the kind's RPC output) only when it changed.
 * Clients that receive pushes stop polling and only check `bots.rev` every REV_CHECK_MS.
 */
export const PUSH_KINDS = ["previews", "workers", "quiet"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export const pushEventName = (kind: PushKind) => `bots.${kind}` as const;

export const PushEventSchema = z.object({ rev: z.number().int(), data: z.unknown() });

export const botsRevRpc = defineRpc({
  name: "bots.rev",
  input: z.object({}),
  output: z.object({
    /** False: this host cannot push (old Paseo); poll as before. */
    push: z.boolean(),
    revs: z.object({ previews: z.number().int(), workers: z.number().int(), quiet: z.number().int() }),
  }),
});

/** Server: how often it recomputes while watched. Local work only, nothing goes on the wire unless it changed. */
export const PUSH_CHECK_MS = 10_000;
/** Server: keep recomputing this long after the last client call (the rev check renews it). */
export const PUSH_LEASE_MS = 3 * 60_000;
/** Client: the safety-net revision check while pushes arrive. */
export const REV_CHECK_MS = 60_000;

/** Kinds whose server revision is not the last one this app applied (null: none applied yet). */
export function staleKinds(
  have: Record<PushKind, number | null>,
  server: Record<PushKind, number>,
): PushKind[] {
  return PUSH_KINDS.filter((kind) => have[kind] !== null && have[kind] !== server[kind]);
}
