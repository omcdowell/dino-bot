/**
 * Bytes of the plugin catalog answer on one connect, before and after pluginBundleCache, using the
 * live daemon's real catalog (read-only: one plugin.catalog.get request).
 *   npx tsx scripts/catalog-bytes.ts
 */
import { zstdCompressSync, deflateRawSync } from "node:zlib";
import { connectToDaemon } from "../../cli/src/utils/client.js";
import { clientBundleHash, pluginCatalogForClient } from "../src/server/plugins/catalog-bundles.js";

const client = await connectToDaemon({
  target: { kind: "instance", home: `${process.env.HOME}/.paseo` },
});
const catalog = await client.getPluginCatalog();
await client.close();
const frame = (plugins: unknown) =>
  JSON.stringify({
    type: "session",
    message: {
      type: "plugin.catalog.get.response",
      payload: { requestId: "r-0123456789", plugins },
    },
  });
// What the app sends: only plugins with a client bundle.
const known = catalog
  .filter((entry) => entry.clientBundle)
  .map((entry) => ({ id: entry.id, hash: clientBundleHash(entry.clientBundle) }));
const cases = {
  "before (every connect)": frame(catalog),
  "after, first connect (knownBundles: [])": frame(pluginCatalogForClient(catalog, [])),
  "after, unchanged bundles": frame(pluginCatalogForClient(catalog, known)),
};
for (const [label, json] of Object.entries(cases)) {
  console.log(
    JSON.stringify({
      label,
      jsonBytes: Buffer.byteLength(json),
      zstdBytes: zstdCompressSync(Buffer.from(json)).length,
      deflateBytes: deflateRawSync(Buffer.from(json)).length,
    }),
  );
}
console.log(
  JSON.stringify({
    plugins: catalog.map((entry) => ({ id: entry.id, bundleChars: entry.clientBundle.length })),
  }),
);
const request = JSON.stringify({
  type: "session",
  message: { type: "plugin.catalog.get.request", requestId: "r-0123456789", knownBundles: known },
});
console.log(JSON.stringify({ requestBytesWithHashes: Buffer.byteLength(request) }));
