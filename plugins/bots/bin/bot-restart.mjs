#!/usr/bin/env node
// bot-restart: the one route for restarting the DinoBot daemon, reloading a plugin or reloading bots' agents.
// Refused from a bot's own session; waits until no bot is mid-turn. Logic in ../bot-restart/cli.ts, run by Node's
// type stripping, like bin/bot-dm.mjs. Symlink this file onto PATH.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  return emitWarning.call(this, warning, ...rest);
};

const { main } = await import('../bot-restart/cli.ts');
await main();
