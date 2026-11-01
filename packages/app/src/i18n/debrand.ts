/**
 * Public flavour: user-visible text names the app (release-flavour.js), not "Paseo". Applied to
 * every locale's resources at init, so new strings are covered without touching each one.
 * Only the capitalised product name is replaced: lower-case `paseo` in file names (paseo.json)
 * and CLI commands is real and stays.
 */
export function debrandText(text: string, appName: string): string {
  return text.replace(/\bPaseo\b/g, appName);
}

export function debrandResources<T>(tree: T, appName: string): T {
  if (typeof tree === "string") return debrandText(tree, appName) as T;
  if (Array.isArray(tree)) return tree.map((item) => debrandResources(item, appName)) as T;
  if (tree && typeof tree === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tree)) out[key] = debrandResources(value, appName);
    return out as T;
  }
  return tree;
}
