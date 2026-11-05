#!/usr/bin/env node
// bot-dm: bot-to-bot DMs through the Paseo daemon (steer mode, stamped sender, guarded, ledgered).
// Logic lives in ../bot-dm/*.ts and ../shared/dm-schema.ts, run directly by Node's type stripping
// (Node >= 22.18 / 23.6). Symlink this file onto PATH; Node resolves the symlink, so the relative
// import below still finds the repo.

// The repo's package.json has no "type" (the Paseo plugin compiler owns it), so Node warns once
// per .ts file that it reparsed it as ESM. Harmless; keep stderr clean for the calling bot.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  return emitWarning.call(this, warning, ...rest);
};

const { main } = await import('../bot-dm/cli.ts');
await main();
