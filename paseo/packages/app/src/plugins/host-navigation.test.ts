import { describe, expect, it } from "vitest";
import { createPluginHostNavigation } from "./host-navigation-model";

describe("plugin host navigation", () => {
  function setup(electron = true) {
    const destinations: unknown[] = [];
    const browsers: string[] = [];
    const workspaces = new Set(["selected:one", "remote:two"]);
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      resolveWorkspace: ({ serverId, workspaceId }) =>
        workspaces.has(`${serverId}:${workspaceId}`) ? workspaceId : null,
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
      createBrowser: ({ initialUrl }) => {
        browsers.push(initialUrl);
        return { browserId: `browser-${browsers.length}` };
      },
    });
    return { navigation, destinations, browsers, workspaces };
  }

  it("creates and focuses a local browser in the selected or explicit host workspace", () => {
    const { navigation, destinations, browsers } = setup();
    navigation.openBrowser!({ url: "https://example.com/one", workspaceId: "one" });
    navigation.openBrowser!({
      url: "https://example.com/two",
      workspaceId: "two",
      serverId: "remote",
    });
    expect(browsers).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: "browser-1" },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "browser", browserId: "browser-2" },
      },
    ]);
  });

  it("refuses unknown or removed workspaces before creating browser records", () => {
    const { navigation, destinations, browsers, workspaces } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "missing" }),
    ).toThrow("Workspace is unavailable");
    expect(() =>
      navigation.openBrowser!({
        url: "https://example.com",
        workspaceId: "one",
        serverId: "unknown",
      }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it("exposes no browser capability outside Electron and creates no tabs", () => {
    const { navigation, destinations, browsers } = setup(false);
    expect(navigation.openBrowser).toBeUndefined();
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "/relative", "invalid"])(
    "rejects %s before creating a browser",
    (url) => {
      const { navigation, browsers, destinations } = setup();
      expect(() => navigation.openBrowser!({ url, workspaceId: "one" })).toThrow("HTTP(S)");
      expect(browsers).toEqual([]);
      expect(destinations).toEqual([]);
    },
  );

  it("rejects an empty workspace before creating a browser", () => {
    const { navigation, browsers } = setup();
    expect(() => navigation.openBrowser!({ url: "https://example.com", workspaceId: "" })).toThrow(
      "workspaceId",
    );
    expect(browsers).toEqual([]);
  });
});

describe("sidebar item navigation", () => {
  function setup(electron = true) {
    const calls: unknown[] = [];
    const navigation = createPluginHostNavigation(
      "selected",
      {
        browserAvailable: electron,
        resolveWorkspace: ({ workspaceId }) => workspaceId,
        openAgent: (input) => calls.push({ open: "agent", ...input }),
        openWorkspace: (input) => calls.push({ open: "workspace", ...input }),
        createBrowser: () => ({ browserId: "browser-1" }),
      },
      () => calls.push("before"),
    );
    return { navigation, calls };
  }

  it("closes the sidebar surface before it opens an agent or a workspace", () => {
    const { navigation, calls } = setup();
    navigation.openAgent({ agentId: "agent-1" });
    navigation.openWorkspace({ workspaceId: "one", serverId: "remote" });
    expect(calls).toEqual([
      "before",
      { open: "agent", serverId: "selected", agentId: "agent-1" },
      "before",
      { open: "workspace", serverId: "remote", workspaceId: "one" },
    ]);
  });

  it("closes the sidebar surface before it opens a browser, and only on Electron", () => {
    const { navigation, calls } = setup();
    navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" });
    expect(calls).toEqual([
      "before",
      {
        open: "workspace",
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: "browser-1" },
      },
    ]);
    expect(setup(false).navigation.openBrowser).toBeUndefined();
  });

  it("leaves the sidebar open when the browser input is refused", () => {
    const { navigation, calls } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "javascript:alert(1)", workspaceId: "one" }),
    ).toThrow("HTTP(S)");
    expect(calls).toEqual([]);
  });
});
