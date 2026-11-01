import { describe, expect, it } from "vitest";
import data from "./licences.generated.json";
import {
  APP_COPYRIGHT,
  electronRuntimeFromUserAgent,
  licenceRows,
  type LicenceData,
} from "./licences-model";

describe("licenceRows", () => {
  const rows = licenceRows(data as LicenceData);
  it("starts with Paseo's Apache-2.0 licence and copyright", () => {
    expect(rows[0]).toMatchObject({
      key: "app",
      title: "Paseo",
      copyright: [APP_COPYRIGHT],
    });
    expect(rows[0]!.text).toContain("Apache License");
    expect(rows[0]!.text).toContain(APP_COPYRIGHT);
  });
  it("lists the host software and the bundled npm packages with their licence texts", () => {
    expect(rows.find((r) => r.key === "extra:pi-optchat")?.copyright).toEqual([
      "Copyright (c) 2026 Jonas Silva",
      "Copyright (c) 2026 omcdowell (modifications)",
      "Prompt adapted, with permission, from Victor Taelin's OptChat recipe",
    ]);
    for (const name of [
      "pi",
      "herdr",
      "Node.js",
      "paseo-bots (bots plugin)",
      "paseo-apns (push plugin)",
    ]) {
      const row = rows.find((r) => r.key === `extra:${name}`);
      expect(row?.text, name).toMatch(/Apache License|Permission is hereby granted/);
    }
    const react = rows.find((r) => r.title === "react");
    expect(react?.subtitle).toMatch(/MIT/);
    expect(react?.text).toMatch(/Permission is hereby granted/);
  });
  it("has no package without a licence id or text", () => {
    const missing = rows.filter(
      (r) => r.key.startsWith("npm:") && (!r.text || /UNKNOWN/.test(r.subtitle)),
    );
    expect(missing.map((r) => r.key)).toEqual([]);
  });
  it("public build: the product notice comes first, names omcdowell and keeps Paseo's credit", () => {
    const pub = licenceRows(data as LicenceData, "DinoBot");
    expect(pub[0]).toMatchObject({
      key: "product",
      title: "DinoBot",
      copyright: ["Copyright 2026 omcdowell"],
    });
    expect(pub[0]!.text).toContain("modified version of Paseo");
    expect(pub[0]!.text).toContain("Mohamed Boudra");
    expect(pub[1]!.key).toBe("app");
  });
  it("desktop app: Electron (MIT) and Chromium rows after the app's own, before the host software", () => {
    const runtime = electronRuntimeFromUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) DinoBot/0.11.2 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36",
    );
    expect(runtime).toEqual({ electronVersion: "44.9.3", chromeVersion: "152.0.7977.167" });
    const desk = licenceRows(data as LicenceData, "DinoBot", runtime);
    expect(desk.map((r) => r.key).slice(0, 4)).toEqual([
      "product",
      "app",
      "runtime:electron",
      "runtime:chromium",
    ]);
    expect(desk[2]).toMatchObject({ title: "Electron 44.9.3" });
    expect(desk[2]!.subtitle).toMatch(/^MIT/);
    expect(desk[2]!.text).toMatch(/Permission is hereby granted/);
    expect(desk[3]).toMatchObject({ title: "Chromium 152.0.7977.167", file: "chromium" });
    expect(desk[3]!.text).toContain("LICENSES.chromium.html");
  });
  it("the phone and the own build have no runtime rows", () => {
    expect(rows.some((r) => r.key.startsWith("runtime:"))).toBe(false);
  });
});
