/**
 * Group chat ("rooms") shared contract, v1.
 *
 * Source of truth: research/group-chat/plan.md §3. Every paseo-bots room unit imports from here
 * (router U1, runner U4, assign U5, UI U6). Additive changes only; tell Emmet before changing a shape.
 *
 * Erasable TypeScript only (no enums, namespaces or parameter properties); imports nothing but `zod`,
 * so it can run under Node type stripping and in the client bundle.
 */
import { z } from "zod";

export const ROOMS_SCHEMA_VERSION = 1;
export { USER } from "../party.ts";
import { USER } from "../party.ts";
export const SYSTEM = "system";

/** §3.1 group id. */
export const GROUP_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Bot folder id under ~/bots (same rule as bot-dm). */
export const BOT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 8;

/** Router caps (plan §2 U1). */
export const HOP_CAP = 6;
export const RATE_CAP = 6;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** Digest limits: at most this many messages / UTF-8 bytes of text per delivery. */
export const DIGEST_MAX_MSGS = 20;
export const DIGEST_MAX_BYTES = 8 * 1024;
/** How many recent room messages the router keeps in its state for digests. */
export const ROUTER_LOG_KEEP = 200;

export const REFUSAL_REASONS = ["hop_cap", "rate_cap", "not_member", "self"] as const;

/**
 * `bot-room post` (a bot's main chat posts a task result to a group). Why a post was refused:
 * `not_bot` (the caller is not a bot's chat), `unknown_group`, `not_member`, `unknown_re` (no such message in the
 * group), `hop_cap` (the --re message's hop + 1 is over HOP_CAP), `rate_cap` (RATE_CAP bot wakes and posts in
 * RATE_WINDOW_MS), `empty`.
 */
export const POST_REFUSAL_CODES = ["not_bot", "unknown_group", "not_member", "unknown_re", "hop_cap", "rate_cap", "empty"] as const;
export type PostRefusalCode = (typeof POST_REFUSAL_CODES)[number];
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/**
 * Lead assignments: any of the group's lead bots may send a member a task with "@Name task: …" in its room reply
 * (same parse as the owner's). At most LEAD_ASSIGN_CAP per group per LEAD_ASSIGN_WINDOW_MS; the hop and rate caps
 * apply first (a task goes only to a member the reply actually woke). The cap is per room: all leads share it.
 */
export const LEAD_ASSIGN_CAP = 3;
export const LEAD_ASSIGN_WINDOW_MS = 10 * 60 * 1000;
/**
 * Why a bot's `task:` was not sent: `not_lead` (only leads assign), `self`, `not_member`, `all` (@all task:),
 * `hop_cap` / `rate_cap` (the wake itself was refused), `assign_cap` (LEAD_ASSIGN_CAP reached).
 */
export const ASSIGN_REFUSAL_REASONS = ["not_lead", "self", "not_member", "all", "hop_cap", "rate_cap", "assign_cap"] as const;
export type AssignRefusalReason = (typeof ASSIGN_REFUSAL_REASONS)[number];
/** `bot` is the member named, or "all" for @all / @everyone. */
export type AssignRefusal = { bot: string; reason: AssignRefusalReason };

// ---------- §3.1 ~/bots/.groups.json ----------

/**
 * `leads`: one or more members. Every message from the owner wakes every lead (it may PASS); any lead may assign
 * tasks. Files written before multi-lead have a single `lead` string; `leadsOf` reads it as `[lead]`.
 */
export type Group = { id: string; name: string; members: string[]; leads: string[] };
export type GroupsFile = { v: 1; groups: Group[] };

/** `leads` from a raw group entry: the `leads` array, else the old single `lead` string as `[lead]`. */
export function leadsOf(raw: { leads?: unknown; lead?: unknown } | null | undefined): unknown {
  if (raw && raw.leads !== undefined) return raw.leads;
  if (raw && typeof raw.lead === "string") return [raw.lead];
  return undefined;
}

export const isLead = (group: Pick<Group, "leads">, bot: string) => group.leads.includes(bot);

/** Members with the leads first (each part in member order). */
export function leadsFirst(group: Pick<Group, "leads" | "members">): string[] {
  return [...group.members.filter((m) => group.leads.includes(m)), ...group.members.filter((m) => !group.leads.includes(m))];
}

export const GroupSchema = z
  .object({
    id: z.string().regex(GROUP_ID_RE, "bad group id"),
    name: z.string().min(1).max(80),
    members: z.array(z.string().regex(BOT_ID_RE, "bad bot id")).min(GROUP_MIN_MEMBERS).max(GROUP_MAX_MEMBERS),
    leads: z.array(z.string()).min(1, "a group needs at least one lead"),
  })
  .refine((g) => g.leads.every((l) => g.members.includes(l)), { message: "every lead must be a member", path: ["leads"] })
  .refine((g) => new Set(g.leads).size === g.leads.length, { message: "duplicate lead", path: ["leads"] })
  .refine((g) => new Set(g.members).size === g.members.length, { message: "duplicate member", path: ["members"] })
  .refine((g) => !g.members.includes(USER) && !g.members.includes(SYSTEM), {
    message: "user/system cannot be members",
    path: ["members"],
  });

export const GroupsFileSchema = z
  .object({ v: z.literal(1), groups: z.array(GroupSchema) })
  .refine((f) => new Set(f.groups.map((g) => g.id)).size === f.groups.length, { message: "duplicate group id" });

// ---------- §3.2 room ledger line ----------

export type RoomRefusal = { bot: string; reason: RefusalReason | string };

export type RoomMessage = {
  v: 1;
  /** ULID. */
  id: string;
  /** ISO time. */
  ts: string;
  group: string;
  /** "user" | "system" | bot id. */
  from: string;
  text: string;
  /** The owner 0; a bot reply is max(hop of the messages addressed to it in its digest) + 1. */
  hop: number;
  /** Bots woken, filled by the router. */
  to: string[];
  refused?: RoomRefusal[];
  /** Digest head this replies to. */
  re?: string;
  assigned?: { bot: string; agentId: string };
  /**
   * The owner turned on Assign in the composer: every member he @named gets the message as a task, as if he had
   * written "@Name task:" (which still works without it).
   */
  task?: boolean;
  /**
   * "main": the bot posted this from its main chat with `bot-room post` (a task's result), not from its room
   * session. `re` is then the room message it answers (the task), and hop is that message's hop + 1.
   */
  via?: "main";
};

export const RoomMessageSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  ts: z.string().min(1),
  group: z.string().regex(GROUP_ID_RE),
  from: z.string().min(1),
  text: z.string(),
  hop: z.number().int().min(0),
  to: z.array(z.string()),
  refused: z.array(z.object({ bot: z.string(), reason: z.string() })).optional(),
  re: z.string().optional(),
  assigned: z.object({ bot: z.string(), agentId: z.string() }).optional(),
  task: z.boolean().optional(),
  via: z.literal("main").optional(),
});

// ---------- router state (router.json) and result ----------

/**
 * Persisted as `router.json` next to the ledger. Plain JSON; the router never mutates its input.
 * - `log`: the last ROUTER_LOG_KEEP routed messages, each with a running sequence number.
 * - `queues[bot]`: ids of messages addressed to `bot` and not yet delivered.
 * - `cursor[bot]`: seq of the newest message at the bot's last delivery.
 * - `wakes`: ms times of bot-initiated wakes inside RATE_WINDOW_MS (rate cap).
 */
export type RouterState = {
  v: 1;
  seq: number;
  log: { seq: number; msg: RoomMessage }[];
  queues: Record<string, string[]>;
  cursor: Record<string, number>;
  wakes: number[];
  /** ms times of lead assignments inside LEAD_ASSIGN_WINDOW_MS (absent in state written before lead assignments). */
  assigns?: number[];
};

export type RouteResult = {
  /** The input message with `to` and `refused` (when any) filled in. Append this to the ledger. */
  message: RoomMessage;
  /** Bots woken (queued). Same as message.to. */
  to: string[];
  refused: RoomRefusal[];
  /**
   * Bots assigned a task (§3.5): by the owner, or by one of the group's lead bots within the caps. Empty for system lines and
   * other bots. U4 calls U5 `assign` for each, from `message.from`.
   */
  assign: string[];
  /** A bot's `task:` that was not sent, and why (empty for the owner and system lines). */
  assignRefused: AssignRefusal[];
  state: RouterState;
};

export function emptyRouterState(): RouterState {
  return { v: 1, seq: 0, log: [], queues: {}, cursor: {}, wakes: [] };
}

export const RouterStateSchema = z.object({
  v: z.literal(1),
  seq: z.number().int().min(0),
  log: z.array(z.object({ seq: z.number().int(), msg: RoomMessageSchema })),
  queues: z.record(z.string(), z.array(z.string())),
  cursor: z.record(z.string(), z.number().int()),
  wakes: z.array(z.number()),
  assigns: z.array(z.number()).optional(),
});
