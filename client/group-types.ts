/** Client-side names for the rooms RPC shapes (U4 `shared/rooms/rpc.ts`, plan §3.4). */
import type { z } from "zod";
import type { MemberState, roomsListRpc, roomsThreadRpc } from "../shared/rooms/rpc";

export type { MemberState };
export type RoomSummary = z.infer<(typeof roomsListRpc)["output"]>["groups"][number];
export type RoomMemberState = z.infer<(typeof roomsThreadRpc)["output"]>["members"][number];
