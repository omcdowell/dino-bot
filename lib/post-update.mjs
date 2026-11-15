// `dinobot post-update`: what `update` does once the new app is in place (wrappers, pi settings,
// the bots' command line, service files, the ~/.local/bin link, saved settings). `update` runs it
// with the NEW version's Node and code (`<app>/node/bin/node <app>/installer/lib/cli.mjs
// post-update`), so a release that changes these steps takes effect in the update that installs
// it. (Before, the old version's code ran them: v0.1.7 -> v0.1.8 needed a second `update` for the
// ~/.local/bin link.) `update` also calls it in-process to put the previous version back.
import { refreshOptchatCommand, writePiSetup, writeWrappers } from "./config.mjs";
import { installEnvPath, saveInstallEnv } from "./install-env.mjs";
import { ensurePathLink } from "./path-link.mjs";
import { writeServices } from "./service.mjs";
import { PRODUCT, readJson } from "./util.mjs";

/** -> {ok, pathLink} or {ok: false, why}. `say` prints what needs the user (the PATH line). */
export async function postUpdate(L, { env = process.env, say = () => {} } = {}) {
  const state = readJson(L.state);
  if (!state) {
    say(`Not set up yet: run the ${PRODUCT} installer first.`);
    return { ok: false, why: "not set up" };
  }
  // An older install kept the shared-Mac settings as exports in ~/.dinobot/bin/dinobot (this
  // process got them from there): moved to install.env before the wrappers are rewritten without.
  saveInstallEnv(env, installEnvPath(L.home));
  writeWrappers(L);
  writePiSetup(L); // new settings (e.g. npmCommand) for an existing pi dir; user changes are kept
  refreshOptchatCommand(L); // bot-only extensions and skills the new app bundles
  writeServices(L, state.serviceMode);
  const pathLink = ensurePathLink(L, { env });
  if (pathLink.status === "created" || pathLink.status === "repaired") say(`Linked ${pathLink.link} -> ${pathLink.target}.`);
  if (pathLink.note) say(pathLink.note);
  return { ok: true, pathLink: pathLink.status };
}
