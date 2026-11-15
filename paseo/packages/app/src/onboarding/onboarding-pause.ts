/**
 * Back on the first onboarding step (sign-in) goes to Welcome, never out of onboarding (N-1, N-2):
 *
 * - N-1: after an in-app scan, Welcome is under the sign-in screen and its "host online, not set
 *   up" effect sent the user straight back in (Back bounced).
 * - N-2: after a pasted or deep link nothing is under it, and Back went to the bots home with
 *   setup unfinished; onboarding was never offered again.
 *
 * So Back marks the host "paused" and goes to Welcome (dismissTo: back to the Welcome under it, or
 * Welcome in place of the sign-in screen). Welcome does not re-route a paused host by itself; it
 * shows "Continue setup", which resumes onboarding at its first step. Memory only: the mark is for
 * this run of the app.
 */
export const ONBOARDING_EXIT_ROUTE = "/welcome";

const paused = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function publish(): void {
  version++;
  for (const l of listeners) l();
}

export function pauseOnboarding(serverId: string): void {
  if (!serverId || paused.has(serverId)) return;
  paused.add(serverId);
  publish();
}

export function resumeOnboarding(serverId: string): void {
  if (paused.delete(serverId)) publish();
}

export function isOnboardingPaused(serverId: string | null | undefined): boolean {
  return Boolean(serverId && paused.has(serverId));
}

/** For useSyncExternalStore: changes whenever a host is paused or resumed. */
export function subscribeOnboardingPause(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function onboardingPauseVersion(): number {
  return version;
}

/** Tests only. */
export function resetOnboardingPause(): void {
  paused.clear();
  publish();
}
