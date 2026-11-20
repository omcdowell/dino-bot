import { describe, expect, it } from "vitest";
import { applyFlavourToCommandHandlers } from "./flavour-commands.js";
import { OWN_DESKTOP_FLAVOUR, publicDesktopFlavour } from "./flavour.js";

const handlers = {
  start_desktop_daemon: () => "started",
  restart_desktop_daemon: () => "restarted",
  check_app_update: () => ({ hasUpdate: true }),
  install_app_update: () => ({ installed: true }),
  install_cli: () => "installed",
  desktop_daemon_status: () => "status",
};

describe("flavour command guards", () => {
  it("own flavour: every handler unchanged", () => {
    const next = applyFlavourToCommandHandlers(handlers, OWN_DESKTOP_FLAVOUR, () => "1.0.0");
    for (const [name, handler] of Object.entries(handlers)) expect(next[name]).toBe(handler);
  });

  it("public flavour: no own daemon, no update checks or installs, no CLI install", () => {
    const next = applyFlavourToCommandHandlers(
      handlers,
      publicDesktopFlavour("DinoBot", "dinobot"),
      () => "0.11.2",
    );
    expect(() => next.start_desktop_daemon!()).toThrow(/DinoBot does not run its own server/);
    expect(() => next.restart_desktop_daemon!()).toThrow(/DinoBot does not run its own server/);
    expect(() => next.install_cli!()).toThrow(/DinoBot does not install a command-line tool/);
    expect(next.check_app_update!()).toMatchObject({
      hasUpdate: false,
      readyToInstall: false,
      currentVersion: "0.11.2",
      latestVersion: "0.11.2",
    });
    expect(next.install_app_update!()).toMatchObject({ installed: false });
    expect(next.desktop_daemon_status).toBe(handlers.desktop_daemon_status);
  });

  it("public flavour with a release repo: check_release_notice asks the release checker", async () => {
    const notice = { latestVersion: "0.2.0" };
    const next = applyFlavourToCommandHandlers(
      handlers,
      publicDesktopFlavour("DinoBot", "dinobot", "0.1.15", "example-owner/example-repo"),
      () => "0.11.2",
      async () => notice,
    );
    expect(await next.check_release_notice!()).toBe(notice);
    // The upstream updater stays off whatever the release notice does.
    expect(next.check_app_update!()).toMatchObject({ hasUpdate: false });
  });

  it("no release repo (own flavour, or a build outside the DinoBot repo): no release check", () => {
    const check = async () => ({});
    expect(
      applyFlavourToCommandHandlers(handlers, OWN_DESKTOP_FLAVOUR, () => "1.0.0", check)
        .check_release_notice,
    ).toBeUndefined();
    expect(
      applyFlavourToCommandHandlers(
        handlers,
        publicDesktopFlavour("DinoBot", "dinobot", "0.1.15"),
        () => "0.11.2",
        check,
      ).check_release_notice,
    ).toBeUndefined();
  });
});
