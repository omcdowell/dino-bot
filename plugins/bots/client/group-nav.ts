import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";

/**
 * `client.openScreen` from the plugin's contribute(): screen components (the phone home) get no
 * openScreen prop, so the home reaches the group screen through this. One per bundle evaluation.
 */
let open: ((input: PluginOpenScreenInput) => void) | null = null;

export function setOpenScreen(value: ((input: PluginOpenScreenInput) => void) | undefined): void {
  open = value ?? null;
}

export const GROUP_SCREEN_ID = "group";

/** Opens the group screen; false when this app cannot open plugin screens from here. */
export function openGroupScreen(group: { id: string; name: string }, via?: (input: PluginOpenScreenInput) => void): boolean {
  const target = via ?? open;
  if (!target) return false;
  target({ screenId: GROUP_SCREEN_ID, params: { groupId: group.id, name: group.name } });
  return true;
}
