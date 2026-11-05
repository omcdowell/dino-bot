import { APP_LINK_SCHEME } from "@/constants/flavour";
import { providerRouteForIncoming, routeForIncoming } from "@/hosts/pair-deep-link";

let attempts = 0;

/**
 * Incoming URLs (expo-router native intent). `<scheme>://pair/#offer=…` from a phone-camera scan
 * of the setup QR goes to the /pair screen with the whole link as a parameter (the router drops
 * the `#offer=` fragment otherwise) and a fresh attempt id, so opening the same link again starts
 * a new attempt. `<scheme>://provider/add?…` (a provider invite such as a private provider package's) goes to
 * /provider-link. Everything else is unchanged.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    attempts += 1;
    return (
      routeForIncoming(path, APP_LINK_SCHEME, `${Date.now().toString(36)}-${attempts}`) ??
      providerRouteForIncoming(path, APP_LINK_SCHEME) ??
      path
    );
  } catch {
    return path;
  }
}
