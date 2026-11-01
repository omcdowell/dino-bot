import { describe, expect, it } from "vitest";
import { ICON_INDEX_KEY } from "./icons";
import { iconStatusFromNative, parseWidgetReport } from "./status";

const index = JSON.stringify({
  emmet: { source: "avatar:avatar.png", savedAt: 1 },
  wallace: { source: "icon:Package", savedAt: 1 },
  gone: { source: "avatar:avatar.png", savedAt: 1 },
});

describe("parseWidgetReport", () => {
  it("reads the widget's JSON", () => {
    expect(
      parseWidgetReport('{"at":1791730000,"read":1,"missing":2,"errors":0,"status":0,"bundled":1}'),
    ).toEqual({
      at: 1791730000,
      read: 1,
      missing: 2,
      errors: 0,
      status: 0,
      bundled: 1,
      memory: null,
      writeFailure: null,
    });
  });

  it("reads the writes the keychain refused before this report got through (wfail, wfails)", () => {
    const base = '"at":5,"read":1,"missing":0,"errors":0,"status":0,"bundled":0';
    expect(parseWidgetReport(`{${base},"wfail":-25308,"wfails":3}`)?.writeFailure).toEqual({
      status: -25308,
      count: 3,
    });
    expect(parseWidgetReport(`{${base},"wfail":-25308}`)?.writeFailure).toBeNull();
  });

  it("reads the widget's own memory in MB: now, peak, and the limit (now + what iOS still allows)", () => {
    expect(
      parseWidgetReport(
        '{"at":5,"read":1,"missing":0,"errors":0,"status":0,"bundled":0,"mem":9,"peak":11,"avail":21}',
      )?.memory,
    ).toEqual({ now: 9, peak: 11, limit: 30 });
  });

  it("no limit when iOS gives none (simulator: avail 0), no memory when a field is missing", () => {
    const base = '"at":5,"read":1,"missing":0,"errors":0,"status":0,"bundled":0';
    expect(parseWidgetReport(`{${base},"mem":16,"peak":17,"avail":0}`)?.memory).toEqual({
      now: 16,
      peak: 17,
      limit: null,
    });
    expect(parseWidgetReport(`{${base},"mem":16,"avail":0}`)?.memory).toBeNull();
  });

  it("null for nothing or junk", () => {
    expect(parseWidgetReport(null)).toBeNull();
    expect(parseWidgetReport("not json")).toBeNull();
    expect(parseWidgetReport('{"at":"x"}')).toBeNull();
    expect(parseWidgetReport("[]")).toBeNull();
  });
});

describe("iconStatusFromNative", () => {
  it("counts the stored avatars from the index, only for ids the keychain holds", () => {
    const status = iconStatusFromNative(
      {
        stored: 2,
        ids: ["emmet", "wallace"],
        readable: 2,
        group: "T.com.example.paseo.shared",
        lastError: null,
        widget: '{"at":5,"read":1,"missing":0,"errors":0,"status":0,"bundled":0}',
        widgetStatus: 0,
      },
      index,
    );
    expect(status).toEqual({
      stored: 2,
      readable: 2,
      avatars: 1,
      group: "T.com.example.paseo.shared",
      lastError: null,
      widget: {
        at: 5,
        read: 1,
        missing: 0,
        errors: 0,
        status: 0,
        bundled: 0,
        memory: null,
        writeFailure: null,
      },
      widgetStatus: 0,
      widgetSource: null,
      appGroup: null,
      dino: null,
      appearance: null,
    });
  });

  it("copes with a build-14 style answer (no ids, readable or widget) and no index", () => {
    expect(iconStatusFromNative({ stored: 3, group: null, lastError: -34018 }, null)).toEqual({
      stored: 3,
      readable: null,
      avatars: 0,
      group: null,
      lastError: -34018,
      widget: null,
      widgetStatus: null,
      widgetSource: null,
      appGroup: null,
      dino: null,
      appearance: null,
    });
  });

  it("keeps the keychain status of the app's read of the report (-25300: never written)", () => {
    const status = iconStatusFromNative(
      {
        stored: 0,
        group: "T.com.example.paseo.shared",
        lastError: null,
        widget: null,
        widgetStatus: -25300,
      },
      null,
    );
    expect(status.widget).toBeNull();
    expect(status.widgetStatus).toBe(-25300);
  });

  it("reads the Lock Screen appearance: the app's, the running card's and the keychain's", () => {
    const status = iconStatusFromNative(
      {
        stored: 0,
        group: "T.com.example.paseo.shared",
        lastError: null,
        appearance: { app: "light", card: "light", keychain: null, keychainStatus: -34018 },
      },
      null,
    );
    expect(status.appearance).toEqual({
      app: "light",
      card: "light",
      keychain: null,
      keychainStatus: -34018,
    });
  });

  it("drops unknown appearance values and a malformed appearance block", () => {
    const odd = iconStatusFromNative(
      {
        stored: 0,
        group: null,
        lastError: null,
        appearance: { app: "sepia", card: null, keychain: "dark", keychainStatus: "x" },
      },
      null,
    );
    expect(odd.appearance).toEqual({
      app: null,
      card: null,
      keychain: "dark",
      keychainStatus: null,
    });
    const junk = iconStatusFromNative(
      { stored: 0, group: null, lastError: null, appearance: "light" as never },
      null,
    );
    expect(junk.appearance).toBeNull();
  });

  it("says where the app found the widget's report and whether this build has the App Group", () => {
    const status = iconStatusFromNative(
      {
        stored: 9,
        group: "T.com.example.paseo.shared",
        lastError: null,
        widget: '{"at":5,"read":9,"missing":0,"errors":0,"status":0,"bundled":0}',
        widgetStatus: 0,
        widgetSource: "group",
        appGroup: { available: true, icons: 9 },
      },
      null,
    );
    expect(status.widgetSource).toBe("group");
    expect(status.appGroup).toEqual({ available: true, icons: 9 });
    const off = iconStatusFromNative(
      {
        stored: 9,
        group: null,
        lastError: null,
        widgetSource: "keychain",
        appGroup: { available: false, icons: null },
      },
      null,
    );
    expect(off.widgetSource).toBe("keychain");
    expect(off.appGroup).toEqual({ available: false, icons: null });
  });

  it("reads the Lock Screen dino's layers: the app's setting, the running card's, the App Group copy", () => {
    const status = iconStatusFromNative(
      { stored: 0, group: null, lastError: null, dino: { app: 6, card: 6, group: null } },
      null,
    );
    expect(status.dino).toEqual({ app: 6, card: 6, group: null });
    const odd = iconStatusFromNative(
      { stored: 0, group: null, lastError: null, dino: { app: 5, card: "6", group: 3 } },
      null,
    );
    expect(odd.dino).toEqual({ app: null, card: null, group: 3 });
    const junk = iconStatusFromNative(
      { stored: 0, group: null, lastError: null, dino: 6 as never },
      null,
    );
    expect(junk.dino).toBeNull();
  });

  it("drops an unknown report source and a malformed App Group block", () => {
    const odd = iconStatusFromNative(
      {
        stored: 0,
        group: null,
        lastError: null,
        widgetSource: "cloud" as never,
        appGroup: { available: "yes", icons: "9" } as never,
      },
      null,
    );
    expect(odd.widgetSource).toBeNull();
    expect(odd.appGroup).toBeNull();
  });

  it("uses the index key the icon sync writes", () => {
    expect(ICON_INDEX_KEY).toBe("@paseo:live-activity-icons:v1");
  });
});
