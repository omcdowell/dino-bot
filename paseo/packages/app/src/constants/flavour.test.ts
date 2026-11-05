import { describe, expect, it } from "vitest";
import { RELEASE_POLICIES, installCommand, resolveAppFlavour } from "./flavour";
import {
  flavourSourcesEnv,
  planFlavour,
  withKeychainGroup,
  withoutBundledAvatars,
} from "../../scripts/apply-flavour.mjs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveFlavour, resolveEas } = require("../../release-flavour.js");

describe("release flavour", () => {
  it("defaults to the own build", () => {
    const own = resolveFlavour({});
    expect(own).toMatchObject({
      id: "own",
      appName: "Paseo",
      iosBundleId: "com.example.paseo",
      supportsTablet: true,
    });
    expect(own.sharedKeychainGroup).toBe("$(AppIdentifierPrefix)com.example.paseo.shared");
    expect(own.appGroup).toBe("group.com.example.paseo");
  });
  it("public: own name and test bundle id, iPhone only, no dev profiles", () => {
    const pub = resolveFlavour({ PASEO_FLAVOUR: "public" });
    expect(pub.id).toBe("public");
    expect(pub.iosBundleId).not.toBe("com.example.paseo");
    expect(pub.appleTeamId).toBeUndefined();
    expect(
      resolveFlavour({ PASEO_FLAVOUR: "public", PASEO_APPLE_TEAM_ID: "TEAM123456" }).appleTeamId,
    ).toBe("TEAM123456");
    expect(resolveFlavour({ PASEO_OWN_BUNDLE_ID: "com.me.paseo" }).appGroup).toBe(
      "group.com.me.paseo",
    );
    expect(pub.supportsTablet).toBe(false);
    expect(pub.provisioningProfile).toBeNull();
    expect(pub.widgetBundleId).toBe(`${pub.iosBundleId}.LiveActivity`);
  });
  it("public name DinoBot (one constant), its own link scheme and Expo push; own unchanged", () => {
    const pub = resolveFlavour({ PASEO_FLAVOUR: "public" });
    expect(pub.appName).toBe("DinoBot");
    // Neutral placeholder: the real id is a build setting (PASEO_BUNDLE_ID), never in the source.
    expect(pub.iosBundleId).toBe("com.example.dinobot");
    expect(pub.widgetBundleId).toBe("com.example.dinobot.LiveActivity");
    expect(pub.linkScheme).toBe("dinobot");
    expect(pub.defaultPushTransport).toBe("expo");
    expect(pub.installUrl).toBe("https://omcdowell.github.io/dino-bot/install");
    expect(installCommand(pub.installUrl)).toBe(
      "curl -fsSL https://omcdowell.github.io/dino-bot/install | sh",
    );
    const own = resolveFlavour({});
    expect(own.linkScheme).toBe("paseo");
    expect(own.defaultPushTransport).toBe("apns");
    expect(own.installUrl).toBeNull();
  });
  it("Apple IDs are build settings: bundle id, widget id and team from the environment", () => {
    const pub = resolveFlavour({
      PASEO_FLAVOUR: "public",
      PASEO_BUNDLE_ID: "org.someone.dinobot",
      PASEO_APPLE_TEAM_ID: "ABCDE12345",
    });
    expect(pub.iosBundleId).toBe("org.someone.dinobot");
    expect(pub.widgetBundleId).toBe("org.someone.dinobot.LiveActivity");
    expect(pub.widgetBundleSuffix).toBe(".LiveActivity");
    expect(pub.appleTeamId).toBe("ABCDE12345");
    expect(pub.sharedKeychainGroup).toBe("$(AppIdentifierPrefix)org.someone.dinobot.shared");
    // The own flavour takes PASEO_BUNDLE_ID too; the older PASEO_OWN_BUNDLE_ID still works.
    expect(resolveFlavour({ PASEO_BUNDLE_ID: "org.someone.paseo" }).iosBundleId).toBe(
      "org.someone.paseo",
    );
    expect(resolveFlavour({ PASEO_OWN_BUNDLE_ID: "org.old.paseo" }).iosBundleId).toBe(
      "org.old.paseo",
    );
    // A widget id of your own, as long as Apple's rule holds (it starts with the app's id + ".").
    const widget = resolveFlavour({
      PASEO_FLAVOUR: "public",
      PASEO_BUNDLE_ID: "org.someone.dinobot",
      PASEO_WIDGET_BUNDLE_ID: "org.someone.dinobot.Widget",
    });
    expect(widget.widgetBundleId).toBe("org.someone.dinobot.Widget");
    expect(widget.widgetBundleSuffix).toBe(".Widget");
    expect(() =>
      resolveFlavour({
        PASEO_BUNDLE_ID: "org.someone.dinobot",
        PASEO_WIDGET_BUNDLE_ID: "org.other.Widget",
      }),
    ).toThrow(/PASEO_WIDGET_BUNDLE_ID/);
  });
  it("a public distribution build refuses the placeholder bundle id; simulator and dev builds keep it", () => {
    expect(() =>
      resolveFlavour({ PASEO_FLAVOUR: "public", PASEO_APNS_ENVIRONMENT: "production" }),
    ).toThrow(/PASEO_BUNDLE_ID is not set/);
    expect(() => resolveFlavour({ PASEO_FLAVOUR: "public", EAS_BUILD: "true" })).toThrow(
      /PASEO_BUNDLE_ID/,
    );
    expect(
      resolveFlavour({
        PASEO_FLAVOUR: "public",
        PASEO_APNS_ENVIRONMENT: "production",
        PASEO_BUNDLE_ID: "org.someone.dinobot",
      }).iosBundleId,
    ).toBe("org.someone.dinobot");
    expect(resolveFlavour({ PASEO_FLAVOUR: "public" }).iosBundleId).toBe("com.example.dinobot");
  });
  it("release policy: public = recommended answers, own = today's behaviour", () => {
    expect(RELEASE_POLICIES.public).toMatchObject({
      debrand: true,
      relayPairing: false,
      tailnetOnly: true,
      networkProbesOnDemand: true,
      upstreamChangelog: false,
      claudePlanDefault: "pro",
      importDefaultOn: false,
      importDefaultDays: 90,
      importShowPlanPercent: false,
      importUntickScratch: true,
      pushPromptAfterFirstReply: true,
    });
    expect(RELEASE_POLICIES.own).toMatchObject({
      pushPromptAfterFirstReply: false,
      debrand: false,
      relayPairing: true,
      tailnetOnly: false,
      upstreamChangelog: true,
      importOnboarding: false,
    });
  });
  it("Expo: public is @dino-bot/dino-bot with no upstream project id; own unchanged", () => {
    const pub = resolveFlavour({ PASEO_FLAVOUR: "public" });
    expect(resolveEas(pub, "expo", {})).toEqual({
      slug: "dino-bot",
      owner: "dino-bot",
      projectId: undefined,
    });
    expect(resolveEas(pub, "expo", { PASEO_EAS_PROJECT_ID: "abc-123" }).projectId).toBe("abc-123");
    expect(resolveEas(pub, "expo", { PASEO_EAS_OWNER: "someone" }).owner).toBe("someone");
    const own = resolveFlavour({});
    expect(resolveEas(own, "apns", {})).toEqual({
      slug: "voice-mobile",
      owner: "getpaseo",
      projectId: "0e7f65ce-0367-46c8-a238-2b65963d235a",
    });
  });
  it("Expo: a public TestFlight build with Expo push and no project id fails clearly", () => {
    const pub = resolveFlavour({ PASEO_FLAVOUR: "public" });
    const prod = { PASEO_APNS_ENVIRONMENT: "production" };
    expect(() => resolveEas(pub, "expo", prod)).toThrow(/PASEO_EAS_PROJECT_ID is not set/);
    expect(() => resolveEas(pub, "expo", { EAS_BUILD: "true" })).toThrow(/@dino-bot\/dino-bot/);
    expect(resolveEas(pub, "none", prod).projectId).toBeUndefined();
    expect(resolveEas(pub, "expo", { ...prod, PASEO_EAS_PROJECT_ID: "id" }).projectId).toBe("id");
  });
  it("desktop: public pairs like the phone (no own daemon, no upstream updates, no SSH hosts)", () => {
    expect(RELEASE_POLICIES.public).toMatchObject({
      desktopBuiltInDaemon: false,
      desktopAppUpdates: false,
      desktopRemoteSsh: false,
      desktopCliInstall: false,
    });
    expect(RELEASE_POLICIES.own).toMatchObject({
      desktopBuiltInDaemon: true,
      desktopAppUpdates: true,
      desktopRemoteSsh: true,
      desktopCliInstall: true,
    });
  });
  it("refuses an unknown flavour", () => {
    expect(() => resolveFlavour({ PASEO_FLAVOUR: "nope" })).toThrow(/own" or "public/);
  });
  it("the app reads extra.flavour; anything else is the own build", () => {
    expect(resolveAppFlavour({ flavour: "public" })).toBe("public");
    expect(resolveAppFlavour({})).toBe("own");
    expect(resolveAppFlavour(null)).toBe("own");
  });
});

describe("apply-flavour (widget sources)", () => {
  const swift =
    'enum BundledAvatars {\n  static let table: [String: String] = [\n    "flint": "iVBOR",\n    "scrat": "iVBOR",\n  ]\n}\n';
  const plist =
    "<key>PaseoSharedKeychainGroup</key>\n    <string>$(AppIdentifierPrefix)com.example.paseo.shared</string>";
  it("public: empty avatar table and the flavour's keychain group", () => {
    expect(withoutBundledAvatars(swift)).toBe(
      "enum BundledAvatars {\n  static let table: [String: String] = [:\n  ]\n}\n",
    );
    expect(withKeychainGroup(plist, "$(AppIdentifierPrefix)x.y.shared")).toContain(
      "<string>$(AppIdentifierPrefix)x.y.shared</string>",
    );
    const plan = planFlavour(resolveFlavour({ PASEO_FLAVOUR: "public" }), {
      "BundledAvatars.swift": swift,
      "Info.plist": plist,
    });
    expect(plan["BundledAvatars.swift"]).not.toContain("flint");
  });
  it("prebuild keeps the build's PASEO_BUNDLE_ID: the widget's keychain group is not the placeholder", () => {
    const env = flavourSourcesEnv("public", {
      PASEO_BUNDLE_ID: "com.dinobot.test",
      PASEO_APNS_ENVIRONMENT: "production",
    });
    expect(env.PASEO_FLAVOUR).toBe("public");
    const plan = planFlavour(resolveFlavour(env), {
      "BundledAvatars.swift": swift,
      "Info.plist": plist,
    });
    expect(plan["Info.plist"]).toContain("<string>$(AppIdentifierPrefix)com.dinobot.test.shared</string>");
    expect(plan["Info.plist"]).not.toContain("com.example");
  });
  it("own: changes nothing", () => {
    expect(
      planFlavour(resolveFlavour({}), {
        "BundledAvatars.swift": swift,
        "Info.plist": plist,
      }),
    ).toEqual({});
  });
});
