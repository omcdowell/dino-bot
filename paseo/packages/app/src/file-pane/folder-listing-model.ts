/**
 * A file tab whose path turns out to be a folder (for example `~/bots` tapped in a chat reply,
 * when the folder is outside the workspace so the Files explorer cannot show it). The daemon
 * answers the read with this message; the pane then lists the folder instead of showing an
 * error with a Retry that can never succeed.
 */
export const NOT_A_FILE_ERROR = "Requested path is not a file";

export function isNotAFileError(message: string | null | undefined): boolean {
  return message?.trim() === NOT_A_FILE_ERROR;
}

export interface FolderListingEntry {
  name: string;
  kind: "file" | "directory";
}

/** Folders first, then files, each by name (case-insensitive). */
export function sortFolderEntries<T extends FolderListingEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

/** The path to open for an entry, in the same form as the folder path ("~/bots" -> "~/bots/x"). */
export function folderEntryPath(folderPath: string, entryName: string): string {
  const base = folderPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) {
    return folderPath.startsWith("/") ? `/${entryName}` : entryName;
  }
  if (base === ".") {
    return entryName;
  }
  return `${base}/${entryName}`;
}

/** The folder above `folderPath`, or null at the top ("~", "/", "C:/" or a workspace-relative name). */
export function parentFolderPath(folderPath: string): string | null {
  const base = folderPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base || base === "~" || base === "." || /^[A-Za-z]:$/.test(base)) {
    return null;
  }
  const lastSlash = base.lastIndexOf("/");
  if (lastSlash < 0) {
    return null;
  }
  if (lastSlash === 0) {
    return "/";
  }
  const parent = base.slice(0, lastSlash);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}
