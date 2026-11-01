/**
 * A model name a user can read (release/app, public flavour). Catalogue labels are often raw ids
 * ("anthropic/claude-sonnet-5-5", "optchat/openrouter/z-ai/glm-5.3"); this keeps the last path
 * segment and spells it out: "Claude Sonnet 5.5", "Glm 5.3". Labels that already read as names
 * (have a space and no slash) are kept as they are.
 */
const UPPER = new Set(["gpt", "glm", "o1", "o3", "o4", "ai"]);

export function friendlyModelLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(" ") && !trimmed.includes("/")) return trimmed;
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (!/[-_]/.test(last) && !/^[a-z]/.test(last)) return last;
  const words = last.split(/[-_]+/).filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    const previous = out[out.length - 1];
    // "5-5" -> "5.5": a version split by the id's dash.
    if (
      /^\d+$/.test(word) &&
      previous &&
      /^\d+(\.\d+)?$/.test(previous) &&
      !previous.includes(".")
    ) {
      out[out.length - 1] = `${previous}.${word}`;
      continue;
    }
    out.push(
      UPPER.has(word.toLowerCase()) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1),
    );
  }
  return out.join(" ");
}

/** The label to show: friendly in the public flavour, unchanged in the owner's build. */
export function displayModelLabel(label: string, publicFlavour: boolean): string {
  return publicFlavour ? friendlyModelLabel(label) : label;
}
