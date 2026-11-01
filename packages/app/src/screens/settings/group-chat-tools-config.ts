import { branded } from "@/constants/flavour";

/**
 * "Group chats: full tools" (27 Oct: "A for groupchats with a toggle in settings to go to B"). The setting
 * lives on the host, in the bots plugin's settings file (`rooms.fullTools`); the app reads and writes it through the
 * plugin's RPCs. Off (default, A): bots in group chats only look things up, read-only. On (B): they get the same tools
 * as in their own chat. pi-optchat reads the file on every room turn, so a change applies from the next room turn.
 * A host without the bots plugin (or with an older one) does not answer the RPC: the card is hidden.
 */
export const GROUP_CHAT_TOOLS_RPC = {
  pluginId: "bots",
  get: "rooms.settings",
  set: "rooms.settings.set",
} as const;

export const GROUP_CHAT_TOOLS_TITLE = "Group chats: full tools";
export const GROUP_CHAT_TOOLS_HINT = branded(
  "Off: bots in group chats can only look things up. On: they get the same tools as in their own chat (files, commands, any web page), with no extra checks, at your own risk. Group chats read other bots' messages and web pages, which can try to steer them. Turn this on only if you trust every bot and the pages they read.",
);

export interface GroupChatToolsAnswer {
  fullTools: boolean;
}

/** The plugin's answer, or null when it is not one (an older plugin, another plugin's reply). */
export function parseGroupChatToolsAnswer(value: unknown): GroupChatToolsAnswer | null {
  if (typeof value !== "object" || value === null) return null;
  const fullTools = (value as { fullTools?: unknown }).fullTools;
  return typeof fullTools === "boolean" ? { fullTools } : null;
}

export interface GroupChatToolsCardState {
  isVisible: boolean;
  isEnabled: boolean;
  isSwitchDisabled: boolean;
  loadingText: string | null;
  errorText: string | null;
}

export function getGroupChatToolsCardState(input: {
  isConnected: boolean;
  answer: GroupChatToolsAnswer | null;
  isPending: boolean;
  error: unknown;
}): GroupChatToolsCardState {
  return {
    isVisible: input.isConnected && input.answer !== null,
    isEnabled: input.answer?.fullTools === true,
    isSwitchDisabled: input.isPending,
    loadingText: input.isPending ? "Updating group chats…" : null,
    errorText: errorText(input.error),
  };
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}
