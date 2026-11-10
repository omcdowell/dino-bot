// Builds the avatar designer web harness (dev only): node scripts/avatar/designer-web/build.mjs [outDir]
// react-native -> react-native-web, react-native-svg (web), Lucide icons and React come from a Paseo checkout
// (PASEO_DIR, default ~/scratch/release/paseo), so the harness draws with the same libraries as the app.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const paseo = process.env.PASEO_DIR ?? join(homedir(), "scratch/release/paseo");
const out = resolve(process.argv[2] ?? join(here, "dist"));
const req = createRequire(join(paseo, "package.json"));
const esbuild = req("esbuild");
const nm = join(paseo, "node_modules");
const client = resolve(here, "../../../client") + "/";

mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [join(here, "harness.tsx")],
  bundle: true,
  outfile: join(out, "harness.js"),
  format: "iife",
  jsx: "automatic",
  target: "es2020",
  nodePaths: [nm, join(paseo, "packages/app/node_modules")],
  mainFields: ["browser", "module", "main"],
  resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".mjs", ".js", ".json"],
  plugins: [
    {
      // Plugin client code gets the host's `react-native` (inset-aware ScrollView, see host-rn.tsx).
      name: "host-react-native",
      setup(b) {
        b.onResolve({ filter: /^react-native$/ }, (args) =>
          args.importer.startsWith(client) ? { path: join(here, "host-rn.tsx") } : undefined,
        );
      },
    },
  ],
  alias: {
    react: join(nm, "react"),
    "react-dom": join(nm, "react-dom"),
    "react-native": join(nm, "react-native-web"),
    "react-native-svg": join(nm, "react-native-svg"),
    "lucide-react-native": join(paseo, "packages/app/node_modules/lucide-react-native"),
    "@getpaseo/plugin/client/react-native": join(here, "plugin-rn-stub.tsx"),
  },
  define: { "process.env.NODE_ENV": '"production"', __DEV__: "false", global: "globalThis" },
  loader: { ".js": "jsx" },
  logLevel: "warning",
});
writeFileSync(
  join(out, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body,#root{margin:0;height:100%}body{font-family:-apple-system,system-ui,sans-serif}</style></head>
<body><div id="root"></div><script src="harness.js"></script></body></html>`,
);
console.log(`built ${out}`);
