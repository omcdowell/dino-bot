import { z } from "zod";

export const DirectTcpHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("directTcp"),
  endpoint: z.string(),
  useTls: z.boolean().optional().default(false),
  password: z.string().optional(),
  /**
   * Daemon public key from pairing. When set, the socket runs the end-to-end encrypted channel
   * (DIRECT_E2EE_SUBPROTOCOL) and nothing, credentials included, is sent until the daemon proves it.
   */
  daemonPublicKeyB64: z.string().min(1).optional(),
});

export type DirectTcpHostConnection = z.input<typeof DirectTcpHostConnectionSchema>;
export type NormalizedDirectTcpHostConnection = z.output<typeof DirectTcpHostConnectionSchema>;
