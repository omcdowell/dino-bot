import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Windows of the host's usage source (an add-on), for the rate-limited card's "Resets …" line. */
export const quotaRpc = defineRpc({
  name: "bots.quota",
  input: z.object({}),
  output: z.object({
    windows: z.array(
      z.object({
        id: z.string(),
        usedPct: z.number().nullable(),
        resetsAt: z.string().nullable(),
        blocked: z.boolean(),
      }),
    ),
    error: z.string().nullable(),
  }),
});
