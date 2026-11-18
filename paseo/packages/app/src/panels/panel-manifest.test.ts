import { describe, expect, it } from "vitest";
import {
  getPanelManifest,
  panelCanLaunchInPane,
  panelResourceKey,
  panelSupportsHost,
} from "@/panels/panel-manifest";

describe("panel manifest", () => {
  it("answers host support without React panel registration", () => {
    expect(panelSupportsHost("agent", "main")).toBe(true);
    expect(panelSupportsHost("agent", "explorer")).toBe(true);
    expect(panelSupportsHost("file", "explorer")).toBe(true);
    expect(panelSupportsHost("network_status", "explorer")).toBe(true);
    expect(panelSupportsHost("files", "explorer")).toBe(true);
    expect(panelSupportsHost("files", "main")).toBe(false);
  });

  it("lets navigation tabs hide their close button without losing their close action", () => {
    expect(getPanelManifest("files").showCloseButton).toBe(false);
    expect(getPanelManifest("agent").showCloseButton).toBe(true);
    expect(getPanelManifest("file").showCloseButton).toBe(true);
    expect(getPanelManifest("network_status").showCloseButton).toBe(true);
  });

  it("hides a singleton launch only when it already exists in the destination pane", () => {
    expect(panelCanLaunchInPane("files", ["files"])).toBe(false);
    expect(panelCanLaunchInPane("files", ["network_status"])).toBe(true);
    expect(panelCanLaunchInPane("files", [])).toBe(true);
    expect(panelCanLaunchInPane("file", ["file"])).toBe(true);
  });

  it("keeps durable resource identity separate from transient target input", () => {
    expect(panelResourceKey({ kind: "file", path: "src/a.ts", lineStart: 1 })).toBe(
      panelResourceKey({ kind: "file", path: "src/a.ts", lineStart: 9 }),
    );
    expect(panelResourceKey({ kind: "file", path: "src/a.ts" })).not.toBe(
      panelResourceKey({ kind: "file", path: "src/b.ts" }),
    );
  });
});
