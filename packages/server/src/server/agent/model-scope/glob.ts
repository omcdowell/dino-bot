/**
 * Glob matching for model references, close to minimatch with `{ nocase: true }` (what Pi uses
 * for `enabledModels`): `*` and `?` stay inside one `/` segment, `**` as a whole segment spans
 * segments, `[...]` classes (`[!...]` negates) and `{a,b}` alternatives. A leading `.` in a segment
 * is only matched by a pattern that spells it, as minimatch does without `dot: true`.
 */

const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|/]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIAL, "\\$&");
}

/** True when Pi treats the pattern as a glob rather than an exact or partial model reference. */
export function isGlobPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

/** Expands `{a,b}` groups (nested groups allowed); a group without a comma stays literal. */
export function expandBraces(pattern: string): string[] {
  const open = findBraceGroup(pattern);
  if (!open) return [pattern];
  const { start, end, parts } = open;
  const head = pattern.slice(0, start);
  const tail = pattern.slice(end + 1);
  return parts.flatMap((part) => expandBraces(`${head}${part}${tail}`));
}

function findBraceGroup(pattern: string): { start: number; end: number; parts: string[] } | null {
  for (let start = 0; start < pattern.length; start++) {
    if (pattern[start] !== "{") continue;
    const group = braceGroupAt(pattern, start);
    if (group) return group;
  }
  return null;
}

/** The brace group opening at `start`, if it closes and has at least two parts. */
function braceGroupAt(
  pattern: string,
  start: number,
): { start: number; end: number; parts: string[] } | null {
  let depth = 0;
  const parts: string[] = [];
  let partStart = start + 1;
  for (let index = start; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth !== 0) continue;
      parts.push(pattern.slice(partStart, index));
      return parts.length > 1 ? { start, end: index, parts } : null;
    } else if (char === "," && depth === 1) {
      parts.push(pattern.slice(partStart, index));
      partStart = index + 1;
    }
  }
  return null;
}

function segmentToRegExp(segment: string): string {
  let out = "";
  // A segment that starts with a wildcard does not match a leading dot.
  if (segment.startsWith("*") || segment.startsWith("?") || segment.startsWith("[")) {
    out += "(?!\\.)";
  }
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;
    if (char === "*") {
      while (segment[index + 1] === "*") index++;
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = segment.slice(index + 1, close);
      let negate = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        negate = true;
        body = body.slice(1);
      }
      const escaped = body.replace(/[\\\]^]/g, "\\$&");
      out += negate ? `[^/${escaped}]` : `[${escaped}]`;
      index = close;
      continue;
    }
    out += escapeRegExp(char);
  }
  return out;
}

function alternativeToRegExp(pattern: string): string {
  const segments = pattern.split("/");
  let out = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // `a/**/b` also matches `a/b`; a trailing `**` matches the rest (no dot segments).
      out += last ? "(?:(?!\\.)[^/]*(?:/(?!\\.)[^/]*)*)?" : "(?:(?!\\.)[^/]*/)*";
      return;
    }
    out += segmentToRegExp(segment);
    if (!last) out += "/";
  });
  return out;
}

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const alternatives = expandBraces(pattern).map(alternativeToRegExp);
  const regexp = new RegExp(`^(?:${alternatives.join("|")})$`, "i");
  if (cache.size > 500) cache.clear();
  cache.set(pattern, regexp);
  return regexp;
}

/** Case-insensitive glob match of a whole string. */
export function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}
