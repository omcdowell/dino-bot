import { describe, expect, it } from "vitest";
import { GLYPH_COLOR, TILE_COLOR, tileSvg } from "./tile";

// Lucide "package" (lucide-react-native 1.50).
const PACKAGE = [
  ["path", { d: "M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8z", key: "1a0edw" }],
  ["path", { d: "M12 22V12", key: "d0xqtd" }],
  ["polyline", { points: "3.29 7 12 12 20.71 7", key: "ousv84" }],
] as const;

describe("tileSvg", () => {
  it("draws the glyph at 48% on a rounded tile, like the bots home", () => {
    const svg = tileSvg(PACKAGE, 100)!;
    expect(svg).toContain(`<rect width="100" height="100" rx="30" fill="${TILE_COLOR}"/>`);
    expect(svg).toContain(`transform="translate(26 26) scale(2)"`);
    expect(svg).toContain(`stroke="${GLYPH_COLOR}" stroke-width="2"`);
    expect(svg).toContain(`<polyline points="3.29 7 12 12 20.71 7"/>`);
    expect(svg).not.toContain("key=");
  });

  it("maps currentColor to the glyph colour, drops unknown tags, odd attributes and quotes", () => {
    const svg = tileSvg(
      [
        ["circle", { cx: 12, cy: 12, r: 2, fill: "currentColor" }],
        ["script", { src: "x" }],
        ["path", { d: 'M0 0"/><x', "on:click": "x" }],
      ],
      96,
    )!;
    expect(svg).toContain(`<circle cx="12" cy="12" r="2" fill="${GLYPH_COLOR}"/>`);
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("on:click");
    expect(svg).toContain(`<path d="M0 0&quot;/>&lt;x"/>`);
  });

  it("null when nothing is drawable", () => {
    expect(tileSvg([["script", {}]], 96)).toBeNull();
  });
});
