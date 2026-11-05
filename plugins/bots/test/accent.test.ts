import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accentFill, accentOn, accentText, DINO_GREEN } from "../client/accent";

const base = {
  surface0: "#ffffff",
  surface1: "#fafafa",
  surface2: "#f4f4f5",
  border: "#e4e4e7",
  foreground: "#1a1a1e",
  foregroundMuted: "#71717a",
  accentForeground: "#2B3318",
  statusSuccess: "#3e704a",
  statusWarning: "#7b5d39",
  statusDanger: "#9d433b",
};

test("dino green apps get the dino green as text, in light and dark", () => {
  assert.equal(DINO_GREEN, "#9CC963");
  assert.equal(accentText({ ...base, accent: "#C7D08E", accentText: "#5E6C2D" } as never), "#9CC963");
  assert.equal(accentText({ ...base, accent: "#c7d08e", accentText: "#C7D08E" } as never), "#9CC963");
  assert.equal(accentText({ ...base, accent: "#C7D08E" }), "#9CC963");
});

test("dino green apps fill with the dino green and draw dark ink on it", () => {
  assert.equal(accentFill({ ...base, accent: "#C7D08E" }), "#9CC963");
  assert.equal(accentOn({ ...base, accent: "#C7D08E" }), "#2B3318");
});

test("other apps keep their accent tokens", () => {
  assert.equal(accentText({ ...base, accent: "#20744A", accentText: "#1A5C3B" } as never), "#1A5C3B");
  assert.equal(accentFill({ ...base, accent: "#20744A" }), "#20744A");
  assert.equal(accentOn({ ...base, accent: "#20744A" }), "#2B3318");
});

test("accentText falls back to the accent on apps that do not send accentText", () => {
  assert.equal(accentText({ ...base, accent: "#20744A" }), "#20744A");
});
