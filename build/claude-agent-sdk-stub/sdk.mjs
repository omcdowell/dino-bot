// DinoBot placeholder for @anthropic-ai/claude-agent-sdk (Copyright 2026 omcdowell, Apache-2.0).
// The real SDK is proprietary ("All rights reserved", Anthropic PBC), so the DinoBot download does
// not include it. Bots do not need it (they run on pi). Paseo's built-in Claude Code coding agent
// does: `dinobot claude-code install` fetches the real package from the npm registry, on this
// computer, under Anthropic's own terms, and replaces this placeholder.
const MESSAGE =
  "Claude Code is not installed in __PRODUCT__. To use the Claude Code coding agent, run on this computer: __PRODUCT_ID__ claude-code install";

export function query() {
  throw new Error(MESSAGE);
}
export async function forkSession() {
  throw new Error(MESSAGE);
}
export const DINOBOT_STUB = true;
