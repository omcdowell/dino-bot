import type { Href } from "expo-router";
import { describe, expect, it } from "vitest";
import {
  redirectIfArchivingActiveWorkspace,
  type RedirectIfArchivingActiveWorkspaceDeps,
} from "@/utils/workspace-archive-redirect";

function createFakeRouter(): { routes: Href[]; deps: RedirectIfArchivingActiveWorkspaceDeps } {
  const routes: Href[] = [];
  return {
    routes,
    deps: {
      navigateToRoute: (route) => {
        routes.push(route);
      },
    },
  };
}

describe("redirectIfArchivingActiveWorkspace", () => {
  it("does not replace the route when archiving an inactive workspace", () => {
    const { deps, routes } = createFakeRouter();
    expect(
      redirectIfArchivingActiveWorkspace(
        {
          serverId: "server-1",
          workspaceId: "feature",
          activeWorkspaceSelection: { serverId: "server-1", workspaceId: "main" },
        },
        deps,
      ),
    ).toBe(false);
    expect(routes).toEqual([]);
  });

  it("moves to the host root when archiving the active workspace", () => {
    const { deps, routes } = createFakeRouter();
    expect(
      redirectIfArchivingActiveWorkspace(
        {
          serverId: "server-1",
          workspaceId: "feature",
          activeWorkspaceSelection: { serverId: "server-1", workspaceId: "feature" },
        },
        deps,
      ),
    ).toBe(true);
    expect(routes).toEqual(["/h/server-1"]);
  });
});
