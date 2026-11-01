/** Taps already turned into a jump. Coming back to the screen (Back) shows the bot page instead of bouncing. */
const consumedNonces = new Set<string>();

/**
 * How long after a tap the bot screen may still jump to the chat. The bot screen stays mounted (hidden)
 * under the chat it opened. A daemon restart or plugin reload evaluates the plugin again, which empties
 * the set above and remounts that hidden screen; without this limit an old tap jumps again.
 * 3 s covers one on-device screen change (normally under 1 s) with room for a slow phone.
 */
export const TAP_JUMP_WINDOW_MS = 3_000;

/** True once per tap, and only soon after it: the bot screen should jump straight to the chat. */
export function claimTapJump(
  nonce: string | undefined,
  consumed: Set<string> = consumedNonces,
  now: number = Date.now(),
): boolean {
  if (!nonce || consumed.has(nonce)) return false;
  // The nonce is the tap time (sidebar.tsx).
  const tappedAt = Number(nonce);
  if (!Number.isFinite(tappedAt) || now - tappedAt > TAP_JUMP_WINDOW_MS) return false;
  consumed.add(nonce);
  return true;
}
