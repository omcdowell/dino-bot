import { describe, expect, it } from "vitest";
import { botDirectoryKey, isBotPlacement, roomKey, withoutBotWorkspaces } from "./bot-workspaces";

const ws = (serverId: string, key: string, dir: string) => ({
  serverId,
  workspaceKey: key,
  workspaceDirectory: dir,
  projectRootPath: dir,
});

describe("bot workspaces in the sidebar (DinoBot desktop)", () => {
  const bots = new Set([botDirectoryKey("s1", "/home/sam/bots/juniper/")]);

  it("drops a bot's project (project row + workspace row) and keeps coding projects", () => {
    const projects = [
      { viewKey: "juniper", workspaces: [ws("s1", "s1:j", "/home/sam/bots/juniper")] },
      { viewKey: "code", workspaces: [ws("s1", "s1:c", "/home/sam/code")] },
      { viewKey: "empty", workspaces: [] },
    ];
    expect(withoutBotWorkspaces(projects, bots).map((p) => p.viewKey)).toEqual(["code", "empty"]);
  });

  it("only matches the same host", () => {
    const projects = [
      { viewKey: "juniper", workspaces: [ws("s2", "s2:j", "/home/sam/bots/juniper")] },
    ];
    expect(withoutBotWorkspaces(projects, bots)).toHaveLength(1);
  });

  it("keeps a project's other workspaces", () => {
    const projects = [
      {
        viewKey: "mixed",
        workspaces: [ws("s1", "s1:j", "/home/sam/bots/juniper"), ws("s1", "s1:w", "/tmp/w")],
      },
    ];
    expect(withoutBotWorkspaces(projects, bots)[0]!.workspaces.map((w) => w.workspaceKey)).toEqual([
      "s1:w",
    ]);
  });

  it("no bots known: everything stays", () => {
    const projects = [{ viewKey: "x", workspaces: [ws("s1", "s1:j", "/home/sam/bots/juniper")] }];
    expect(withoutBotWorkspaces(projects, new Set())).toEqual(projects);
  });

  it("recognises a bot placement by its directory (or project root)", () => {
    expect(isBotPlacement(ws("s1", "s1:j", "/home/sam/bots/juniper"), bots)).toBe(true);
    expect(
      isBotPlacement(
        { serverId: "s1", workspaceKey: "k", projectRootPath: "/home/sam/bots/juniper" },
        bots,
      ),
    ).toBe(true);
    expect(isBotPlacement({ serverId: "s1", workspaceKey: "k" }, bots)).toBe(false);
  });
  it("also drops a group chat's room workspace (…/bot-rooms/<group id>), only for known groups", () => {
    const keys = new Set([roomKey("s1", "dino-crew")]);
    const room = ws("s1", "s1:r", "/home/sam/.local/state/bot-rooms/dino-crew");
    expect(isBotPlacement(room, keys)).toBe(true);
    expect(isBotPlacement(ws("s1", "s1:o", "/home/sam/.local/state/bot-rooms/other"), keys)).toBe(
      false,
    );
    expect(isBotPlacement(ws("s1", "s1:x", "/home/sam/code/dino-crew"), keys)).toBe(false);
  });
});
