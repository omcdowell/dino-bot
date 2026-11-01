import { describe, expect, it } from "vitest";
import { debrandResources, debrandText } from "./debrand";
import { en } from "./resources/en";
import { ja } from "./resources/ja";

describe("debrand", () => {
  it("replaces the product name only", () => {
    expect(debrandText("Welcome to Paseo", "DinoBot")).toBe("Welcome to DinoBot");
    expect(debrandText("Couldn't load paseo.json", "DinoBot")).toBe("Couldn't load paseo.json");
    expect(debrandText("Paseoを終了中...", "DinoBot")).toBe("DinoBotを終了中...");
  });
  it("leaves no user-visible Paseo in any English or Japanese string", () => {
    for (const tree of [en, ja]) {
      const values: string[] = [];
      const walk = (node: unknown): void => {
        if (typeof node === "string") values.push(node);
        else if (node && typeof node === "object") Object.values(node).forEach(walk);
      };
      walk(debrandResources(tree, "DinoBot"));
      expect(values.filter((v) => v.includes("Paseo"))).toEqual([]);
    }
  });
});
