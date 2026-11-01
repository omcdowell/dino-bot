import type { DesktopCommandHandler } from "./settings/desktop-settings-commands.js";
import type { DesktopFlavour } from "./flavour.js";

/**
 * Main-process side of the public flavour's ReleasePolicy flags (desktopBuiltInDaemon,
 * desktopAppUpdates, desktopCliInstall). The public renderer never calls these commands; this keeps
 * the main process from doing it anyway: no daemon in ~/.paseo, no update checks against upstream
 * Paseo's GitHub releases (the public build has no update feed), no `paseo` CLI in ~/.local/bin.
 */
export function applyFlavourToCommandHandlers(
  handlers: Record<string, DesktopCommandHandler>,
  flavour: DesktopFlavour,
  currentVersion: () => string,
): Record<string, DesktopCommandHandler> {
  const next = { ...handlers };
  const unavailable = (what: string) => () => {
    throw new Error(`${flavour.appName} does not ${what}.`);
  };
  if (!flavour.builtInDaemon) {
    next.start_desktop_daemon = unavailable("run its own server; it pairs with your computer's");
    next.restart_desktop_daemon = unavailable("run its own server; it pairs with your computer's");
  }
  if (!flavour.appUpdates) {
    next.check_app_update = () => ({
      hasUpdate: false,
      readyToInstall: false,
      currentVersion: currentVersion(),
      latestVersion: currentVersion(),
      body: null,
      date: null,
      errorMessage: null,
    });
    next.install_app_update = () => ({
      installed: false,
      version: null,
      message: `${flavour.appName} updates come with the installer (dinobot update).`,
    });
  }
  if (!flavour.cliInstall) {
    next.install_cli = unavailable("install a command-line tool");
  }
  return next;
}
