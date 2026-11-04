import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Plugin id in paseo-plugin.json; the app calls `invokePluginRpc(APNS_PLUGIN_ID, "register", …)`. */
export const APNS_PLUGIN_ID = "apns";

const DeviceToken = z.string().regex(/^[0-9a-fA-F]{64,200}$/, "not an APNs device token");

export const registerRpc = defineRpc({
  name: "register",
  input: z.object({
    token: DeviceToken,
    /** "development" for ship.sh / Xcode builds (sandbox host), "production" for TestFlight / App Store. */
    environment: z.enum(["development", "production"]),
    /** The app's bundle id; must match the add-on's configured topic. */
    topic: z.string().min(1).max(155),
    name: z.string().max(80).nullable().optional(),
  }),
  output: z.object({ ok: z.boolean(), devices: z.number(), reason: z.string().nullable() }),
});

export const revokeRpc = defineRpc({
  name: "revoke",
  input: z.object({ token: DeviceToken }),
  output: z.object({ ok: z.boolean(), removed: z.boolean() }),
});

const Appearance = z.enum(["light", "dark"]);
/** The app's Lock Screen dino setting: 3 or 6 fps (the app sends nothing else). */
const DinoLayers = z.union([z.literal(3), z.literal(6)]);

const ActivityState = z.object({
  bots: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      working: z.boolean(),
      workers: z.number().int(),
      since: z.number(),
      // Stalled bot / stalled worker count (bots plugin): optional, so the widget can grey them.
      // Without them here the sync answer (zod strips unknown keys) would drop them.
      stalled: z.boolean().optional(),
      stalledWorkers: z.number().int().optional(),
    }),
  ),
  more: z.number().int(),
});

/**
 * The app's Live Activity sync (server/live-activity.ts): on every connect and token change it
 * sends its push-to-start token and the activities it holds; the answer is the state to show
 * (null: no bot busy, end them).
 */
export const liveActivitySyncRpc = defineRpc({
  name: "live-activity.sync",
  input: z.object({
    /** Random id the app keeps per installation (one phone may hold several activities). */
    installId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    environment: z.enum(["development", "production"]),
    /** The app's bundle id; must match the add-on's configured topic. */
    topic: z.string().min(1).max(155),
    startToken: DeviceToken.nullable(),
    activities: z.array(z.object({ id: z.string().min(1).max(100), token: DeviceToken.nullable() })).max(8),
    /**
     * The phone's light/dark setting (the app reads it; iOS 26 hides it from the widget). Goes into
     * the content state of this install's pushes so the Lock Screen card keeps the right look.
     * Optional: older apps do not send it.
     */
    appearance: Appearance.nullable().optional(),
    /**
     * The phone's Lock Screen dino setting (3 or 6 fps). The widget cannot read the app's copy on
     * the phone, so it goes into the content state of this install's pushes, like `appearance`.
     * Optional: older apps do not send it.
     */
    dinoLayers: DinoLayers.nullable().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    reason: z.string().nullable(),
    state: ActivityState.nullable(),
    staleDate: z.number().nullable(),
    /**
     * false: this host cannot push to the phone (local mode), so the activity changes only while the
     * app is open; the app polls the sync then. Optional: older add-ons do not send it.
     */
    pushes: z.boolean().optional(),
  }),
});
