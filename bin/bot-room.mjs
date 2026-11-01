#!/usr/bin/env node
// bot-room: a bot's main chat posts a task result into a group chat (bot-room post <group> --re <id> --text ...).
// Logic lives in ../bot-room/cli.ts (checks and delivery in the Bots plugin, rooms.botPost), run directly by Node's
// type stripping, like bin/bot-dm.mjs. Symlink this file onto PATH; Node resolves the symlink, so the relative
// import below still finds the repo.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  return emitWarning.call(this, warning, ...rest);
};

const { main } = await import('../bot-room/cli.ts');
await main();
