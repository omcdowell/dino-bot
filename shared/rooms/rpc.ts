import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BOT_ID_RE, GROUP_ID_RE, GROUP_MAX_MEMBERS, POST_REFUSAL_CODES, RoomMessageSchema } from "./schema";

/** Group screen RPCs (plan §3.4). */

const GroupIdSchema = z.string().regex(GROUP_ID_RE, "not a group id");


export const RoomMemberSchema = z.object({
  botId: z.string(),
  name: z.string(),
  icon: z.string(),
  avatarHash: z.string().nullable(),
});

export const roomsListRpc = defineRpc({
  name: "rooms.list",
  input: z.object({}),
  output: z.object({
    groups: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        /** One or more members; every message from the user wakes them all. */
        leads: z.array(z.string()),
        members: z.array(RoomMemberSchema),
        lastTs: z.string().nullable(),
        lastPreview: z.string().nullable(),
      }),
    ),
  }),
});

export const MemberStateSchema = z.enum(["idle", "room", "main-busy", "queued"]);
export type MemberState = z.infer<typeof MemberStateSchema>;

export const roomsThreadRpc = defineRpc({
  name: "rooms.thread",
  input: z.object({ groupId: GroupIdSchema, before: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
  output: z.object({
    messages: z.array(RoomMessageSchema),
    members: z.array(z.object({ botId: z.string(), state: MemberStateSchema, queued: z.number().int() })),
  }),
});

export const ROOM_POST_MAX = 8000;

export const roomsPostRpc = defineRpc({
  name: "rooms.post",
  input: z.object({
    groupId: GroupIdSchema,
    text: z.string().min(1).max(ROOM_POST_MAX),
    /** Composer Assign toggle: the @named members get the message as a task (same path as "@Name task:"). */
    assign: z.boolean().optional(),
  }),
  output: z.object({
    id: z.string(),
    to: z.array(z.string()),
    assigned: z.array(z.string()),
    refused: z.array(z.object({ bot: z.string(), reason: z.string() })),
  }),
});

/**
 * `bot-room post`: a bot's main chat posts into a group it is a member of, answering the room message `re` (the task
 * it was given there). The plugin identifies the bot from `agentId` (the caller's PASEO_AGENT_ID: a chat of that bot,
 * never a room session); `from` alone is the operator test path (bot-room run outside any agent with
 * BOT_ROOM_OPERATOR=1). Refusals come back as `ok: false` with a code and reason, never as a post.
 */
export const roomsBotPostRpc = defineRpc({
  name: "rooms.bot-post",
  input: z.object({
    groupId: GroupIdSchema,
    re: z.string().min(1).max(80),
    text: z.string().max(ROOM_POST_MAX),
    agentId: z.string().min(1).optional(),
    from: z.string().regex(BOT_ID_RE, "not a bot id").optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    /** Set when ok. */
    id: z.string().optional(),
    from: z.string().optional(),
    hop: z.number().int().optional(),
    /** Members the post woke (its @mentions, within the caps). */
    to: z.array(z.string()),
    refused: z.array(z.object({ bot: z.string(), reason: z.string() })),
    /** The same post (bot, re, text) was already in the ledger: nothing new written. */
    duplicate: z.boolean().optional(),
    code: z.enum(POST_REFUSAL_CODES).optional(),
    reason: z.string().optional(),
  }),
});

/**
 * Group info sheet: set a group's members and leads (add, remove, toggle lead). The server checks
 * them (known bots, 2-8 members, at least one lead, every lead a member), rewrites `~/bots/.groups.json`
 * (keeping `.bak`, writing `leads`), stops removed members' room sessions, posts a system line and pushes ROOMS_EVENT.
 */
export const roomsSetMembersRpc = defineRpc({
  name: "rooms.members.set",
  input: z.object({
    groupId: GroupIdSchema,
    members: z.array(z.string().regex(BOT_ID_RE, "not a bot id")).min(1).max(GROUP_MAX_MEMBERS + 1),
    leads: z.array(z.string().regex(BOT_ID_RE, "not a bot id")).max(GROUP_MAX_MEMBERS + 1),
  }),
  output: z.object({
    members: z.array(z.string()),
    leads: z.array(z.string()),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
});

/**
 * Push: the server emits ROOMS_EVENT `{ rev, data: { groupId } }` (PushEventSchema shape) whenever a
 * group's ledger or member states change; the screen refetches `rooms.thread` for that group.
 * Hosts without plugin events: poll `rooms.thread` every ROOMS_POLL_MS while the screen is open.
 */
export const ROOMS_EVENT = "bots.rooms";
export const ROOMS_POLL_MS = 3_000;
export const DEFAULT_THREAD_LIMIT = 100;

/**
 * Group chat settings (app Settings > host > Agents, "Group chats: full tools"). `fullTools` false (default): room
 * sessions only talk and look things up, read-only; true: the same tools as a bot's main chat. Applies from the next
 * room turn (pi-optchat reads the settings file each turn).
 */
export const roomsSettingsRpc = defineRpc({
  name: "rooms.settings",
  input: z.object({}),
  output: z.object({ fullTools: z.boolean() }),
});

export const roomsSettingsSetRpc = defineRpc({
  name: "rooms.settings.set",
  input: z.object({ fullTools: z.boolean() }),
  output: z.object({ fullTools: z.boolean() }),
});
