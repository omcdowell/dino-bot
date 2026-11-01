import AsyncStorage from "@react-native-async-storage/async-storage";
import { RELEASE_POLICY } from "@/constants/flavour";
import { buildHostRootRoute } from "@/utils/host-routes";
import { needsSetup } from "./setup-model";
import { nextStep, stepRoute, type OnboardingStep } from "./onboarding-model";

const KEY = "paseo:setup-done-hosts";

async function readDone(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export async function markSetupDone(serverId: string): Promise<void> {
  const done = await readDone();
  if (done.includes(serverId)) return;
  await AsyncStorage.setItem(KEY, JSON.stringify([...done, serverId])).catch(() => undefined);
}

/** Where a fresh pairing goes: the first onboarding step (public flavour), else the host. */
export async function routeAfterPairing(serverId: string): Promise<string> {
  if (needsSetup(RELEASE_POLICY, await readDone(), serverId)) {
    const first = nextStep(RELEASE_POLICY.onboardingSteps, null);
    if (first) return stepRoute(first, serverId);
  }
  return buildHostRootRoute(serverId);
}

/** After `current`: the next onboarding step, or (marking setup done) the host. */
export async function routeAfterStep(current: OnboardingStep, serverId: string): Promise<string> {
  const next = nextStep(RELEASE_POLICY.onboardingSteps, current);
  if (next) return stepRoute(next, serverId);
  await markSetupDone(serverId);
  return buildHostRootRoute(serverId);
}
