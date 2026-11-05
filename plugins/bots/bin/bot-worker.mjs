#!/usr/bin/env node
// bot-worker: record which bot launched which herdr worker (launch registry for the Bots sidebar's
// "waiting for workers" state). Logic in ../bot-worker/cli.ts and ../server/workers.ts, run by
// Node's type stripping, like bin/bot-dm.mjs. Symlink this file onto PATH if wanted.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  return emitWarning.call(this, warning, ...rest);
};

const { main } = await import('../bot-worker/cli.ts');
await main();
