/**
 * DinoBot desktop app: bots and group chats are listed once, in the Bots list at the top of the
 * sidebar. Their workspaces (a bot's folder, e.g. ~/bots/juniper, and a group chat's room folder,
 * ~/.local/state/bot-rooms/<group id>) are left out of the Workspaces list, where they showed up a
 * second time as a project row plus a workspace row. Pure; the sidebar model applies it.
 */

function normalizeDirectory(path: string): string {
  return path.trim().replace(/\/+$/, "");
}

export function botDirectoryKey(serverId: string, directory: string): string {
  return `${serverId}\u0000${normalizeDirectory(directory)}`;
}

/** A group chat's room folder: `<rooms root>/<group id>`, the rooms root being `…/bot-rooms`. */
export function roomKey(serverId: string, groupId: string): string {
  return `${serverId}\u0000room:${groupId}`;
}

function roomKeyOf(serverId: string, directory: string): string | null {
  const parts = normalizeDirectory(directory).split("/");
  const groupId = parts.at(-1);
  return parts.at(-2) === "bot-rooms" && groupId ? roomKey(serverId, groupId) : null;
}

interface PlacementLike {
  serverId: string;
  workspaceKey: string;
  workspaceDirectory?: string;
  projectRootPath?: string;
}

export function isBotPlacement(
  placement: PlacementLike,
  botDirectoryKeys: ReadonlySet<string>,
): boolean {
  const directory = placement.workspaceDirectory ?? placement.projectRootPath;
  if (!directory) return false;
  if (botDirectoryKeys.has(botDirectoryKey(placement.serverId, directory))) return true;
  const room = roomKeyOf(placement.serverId, directory);
  return room !== null && botDirectoryKeys.has(room);
}

/** Projects without their bot workspaces; a project left with none (it was a bot's) goes too. */
export function withoutBotWorkspaces<P extends { workspaces: readonly PlacementLike[] }>(
  projects: readonly P[],
  botDirectoryKeys: ReadonlySet<string>,
): P[] {
  if (botDirectoryKeys.size === 0) return [...projects];
  return projects.flatMap((project) => {
    const workspaces = project.workspaces.filter(
      (workspace) => !isBotPlacement(workspace, botDirectoryKeys),
    );
    if (workspaces.length === project.workspaces.length) return [project];
    return workspaces.length > 0 ? [{ ...project, workspaces }] : [];
  });
}
