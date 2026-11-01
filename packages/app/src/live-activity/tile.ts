/**
 * The bot's Lucide icon as the bots home draws it when a bot has no avatar image: the glyph at 48%
 * of the size on a rounded tile (radius 30%), Paseo dark `surface2` tile, `foreground` glyph,
 * stroke 2 on Lucide's 24-unit grid. Built as one SVG string, rasterized by Skia (index.ios.ts).
 */

export type LucideNode = ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]>;

export const TILE_COLOR = "#272A29";
export const GLYPH_COLOR = "#fafafa";
const TAGS = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
const ATTR = /^[a-z][a-zA-Z0-9-]*$/;

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function round(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** The tile SVG, or null when the node has nothing drawable. */
export function tileSvg(node: LucideNode, size: number): string | null {
  const children: string[] = [];
  for (const [tag, attrs] of node) {
    if (!TAGS.has(tag)) continue;
    const parts: string[] = [];
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "key" || !ATTR.test(name)) continue;
      if (typeof value !== "string" && typeof value !== "number") continue;
      const text = String(value) === "currentColor" ? GLYPH_COLOR : String(value);
      parts.push(`${name}="${escape(text)}"`);
    }
    children.push(`<${tag} ${parts.join(" ")}/>`);
  }
  if (children.length === 0) return null;
  const glyph = size * 0.48;
  const offset = (size - glyph) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${round(size * 0.3)}" fill="${TILE_COLOR}"/>` +
    `<g transform="translate(${round(offset)} ${round(offset)}) scale(${round(glyph / 24)})" fill="none" ` +
    `stroke="${GLYPH_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    children.join("") +
    `</g></svg>`
  );
}
