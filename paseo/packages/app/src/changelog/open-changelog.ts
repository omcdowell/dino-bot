import { RELEASE_POLICY } from "@/constants/flavour";
import { useChangelogStore } from "./internal/changelog-store";

/** Opens the What's new sheet from anywhere, including outside React. */
export function openChangelog(): void {
  // Public flavour: no request to GitHub at all (ReleasePolicy.upstreamChangelog).
  if (!RELEASE_POLICY.upstreamChangelog) return;
  useChangelogStore.getState().open();
}
