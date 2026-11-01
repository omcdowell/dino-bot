import { createHash } from "node:crypto";

interface CatalogEntry {
  id: string;
  clientBundle: string;
}

export interface KnownClientBundle {
  id: string;
  hash: string;
}

// The runtime hands out the same bundle string on every catalog read, so the lookup is cheap.
const hashes = new Map<string, string>();

/** sha256 of the client bundle, base64url; remembered per bundle so a connect hashes nothing. */
export function clientBundleHash(bundle: string): string {
  const cached = hashes.get(bundle);
  if (cached) return cached;
  const hash = createHash("sha256").update(bundle).digest("base64url");
  if (hashes.size >= 64) hashes.clear();
  hashes.set(bundle, hash);
  return hash;
}

/**
 * The plugin catalog as one app should get it (pluginBundleCache).
 * - `known` undefined: an app without the plugin cache; the catalog goes out unchanged.
 * - otherwise every entry with a client bundle carries its hash, and a bundle the app already has (same plugin,
 *   same hash) goes out empty with `clientBundleUnchanged`, so a connect does not resend it.
 */
export function pluginCatalogForClient<T extends CatalogEntry>(
  catalog: readonly T[],
  known: readonly KnownClientBundle[] | undefined,
): Array<T & { clientBundleHash?: string; clientBundleUnchanged?: boolean }> {
  if (!known) return [...catalog];
  const knownById = new Map(known.map((entry) => [entry.id, entry.hash]));
  return catalog.map((entry) => {
    // Server-only plugins have no client bundle: nothing to cache or hash.
    if (!entry.clientBundle) return entry;
    const hash = clientBundleHash(entry.clientBundle);
    if (knownById.get(entry.id) === hash) {
      return { ...entry, clientBundle: "", clientBundleHash: hash, clientBundleUnchanged: true };
    }
    return { ...entry, clientBundleHash: hash };
  });
}
