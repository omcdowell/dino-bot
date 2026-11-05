import { providerRouteForIncoming, routeForIncoming } from "@/hosts/pair-deep-link";

/**
 * Route for a link the desktop app was opened with: the same rules as the phone's
 * +native-intent.tsx (pairing link -> /pair with a fresh attempt id, provider invite ->
 * /provider-link). Null for anything else.
 */
export function desktopAppLinkRoute(link: string, scheme: string, attempt: string): string | null {
  return routeForIncoming(link, scheme, attempt) ?? providerRouteForIncoming(link, scheme);
}
