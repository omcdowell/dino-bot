import { describe, expect, test } from "vitest";
import { clientBundleHash, pluginCatalogForClient } from "./catalog-bundles.js";

const catalog = [
  { id: "apns", clientBundle: "apns-bundle" },
  { id: "bots", clientBundle: "bots-bundle", requirements: { paseo: ">=0.8.0" } },
];

describe("pluginCatalogForClient", () => {
  test("an app without the plugin cache gets the catalog exactly as before", () => {
    expect(pluginCatalogForClient(catalog, undefined)).toEqual(catalog);
  });

  test("an app with the cache but no bundles yet gets every bundle and its hash", () => {
    expect(pluginCatalogForClient(catalog, [])).toEqual([
      {
        id: "apns",
        clientBundle: "apns-bundle",
        clientBundleHash: clientBundleHash("apns-bundle"),
      },
      {
        id: "bots",
        clientBundle: "bots-bundle",
        requirements: { paseo: ">=0.8.0" },
        clientBundleHash: clientBundleHash("bots-bundle"),
      },
    ]);
  });

  test("a bundle the app already has is not sent again; a changed one is", () => {
    const known = [
      { id: "bots", hash: clientBundleHash("bots-bundle") },
      { id: "apns", hash: clientBundleHash("old-apns-bundle") },
    ];
    expect(pluginCatalogForClient(catalog, known)).toEqual([
      {
        id: "apns",
        clientBundle: "apns-bundle",
        clientBundleHash: clientBundleHash("apns-bundle"),
      },
      {
        id: "bots",
        clientBundle: "",
        requirements: { paseo: ">=0.8.0" },
        clientBundleHash: clientBundleHash("bots-bundle"),
        clientBundleUnchanged: true,
      },
    ]);
  });

  test("a hash is only good for the plugin it was given for", () => {
    const known = [{ id: "apns", hash: clientBundleHash("bots-bundle") }];
    const [apns, bots] = pluginCatalogForClient(catalog, known);
    expect(apns).toMatchObject({ clientBundle: "apns-bundle" });
    expect(apns).not.toHaveProperty("clientBundleUnchanged");
    expect(bots).toMatchObject({ clientBundle: "bots-bundle" });
  });

  test("plugins without a client bundle go out as they are", () => {
    const serverOnly = [{ id: "usage", clientBundle: "" }];
    expect(pluginCatalogForClient(serverOnly, [])).toEqual(serverOnly);
  });

  test("hashes are stable, content-based and short", () => {
    expect(clientBundleHash("bots-bundle")).toBe(clientBundleHash("bots-bundle"));
    expect(clientBundleHash("bots-bundle")).not.toBe(clientBundleHash("bots-bundle "));
    expect(clientBundleHash("x".repeat(22_000))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
