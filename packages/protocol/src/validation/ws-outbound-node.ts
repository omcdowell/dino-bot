import type { z } from "zod";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "../messages.js";

type WSOutboundValidationResult =
  | { success: true; data: WSOutboundMessage }
  | { success: false; error: z.ZodError };

// Node resolves "@getpaseo/protocol/validation/ws-outbound" here (package.json "node" condition):
// the zod schema the AOT validator is compiled from. The AOT build exists for Hermes, which has no
// JIT; under V8 its 13 MB module costs ~85 MB of resident memory in every Node process that holds
// a DaemonClient (the daemon's plugin clients, the plugin process, the CLI), and zod's own JIT
// validates fast enough there. The phone and web bundles keep ./ws-outbound.ts.
export function validateWSOutboundMessage(input: unknown): WSOutboundValidationResult {
  return WSOutboundMessageSchema.safeParse(input);
}
