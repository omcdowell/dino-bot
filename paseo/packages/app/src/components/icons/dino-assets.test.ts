import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dinoLineSvg } from "./dino-line-svg";

const APP = join(__dirname, "../../..");
const config = readFileSync(join(APP, "app.config.js"), "utf8");

function pngSize(path: string): { width: number; height: number; colorType: number } {
  const buf = readFileSync(path);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

// Sam 2026-10-11: dino app icon, colour in light mode and mono in dark mode; every Paseo mark
// becomes the dino line art (black lines on light, white lines on dark).
describe("dino icon assets", () => {
  it("gives iOS a light and a dark app icon, both 1024 px and opaque", () => {
    expect(config).toMatch(/light: "\.\/assets\/images\/icon\.png"/);
    expect(config).toMatch(/dark: "\.\/assets\/images\/icon-dark\.png"/);
    for (const name of ["icon.png", "icon-dark.png"]) {
      expect(pngSize(join(APP, "assets/images", name))).toEqual({
        width: 1024,
        height: 1024,
        colorType: 2,
      });
    }
  });

  it("uses a dark launch-screen image next to the light one", () => {
    expect(config).toMatch(/image: "\.\/assets\/images\/splash-icon-dark\.png"/);
    expect(existsSync(join(APP, "assets/images/splash-icon-dark.png"))).toBe(true);
  });

  it("draws the in-app logo from the transparent dino line art", () => {
    const logo = readFileSync(join(__dirname, "paseo-logo.tsx"), "utf8");
    expect(logo).toMatch(/assets\/images\/dino-line\.png/);
    expect(pngSize(join(APP, "assets/images/dino-line.png")).colorType).toBe(6);
  });

  it("builds the web splash mask from the dino line art at the requested size", () => {
    const svg = dinoLineSvg(88);
    expect(svg).toContain("width='88' height='88' viewBox='0 0 1024 1024'");
    expect(svg).toContain("mask='url(#dino-lines)'");
    expect(svg).not.toContain('"');
  });
});
