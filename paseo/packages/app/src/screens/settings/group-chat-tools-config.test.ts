import { describe, expect, it } from "vitest";
import {
  GROUP_CHAT_TOOLS_HINT,
  GROUP_CHAT_TOOLS_RPC,
  GROUP_CHAT_TOOLS_TITLE,
  getGroupChatToolsCardState,
  parseGroupChatToolsAnswer,
} from "./group-chat-tools-config";

describe("group chat tools setting", () => {
  it("names the bots plugin RPCs (lower case, as the daemon requires)", () => {
    expect(GROUP_CHAT_TOOLS_RPC).toEqual({
      pluginId: "bots",
      get: "rooms.settings",
      set: "rooms.settings.set",
    });
    for (const name of [GROUP_CHAT_TOOLS_RPC.get, GROUP_CHAT_TOOLS_RPC.set]) {
      expect(name).toMatch(/^[a-z][a-z0-9._-]*$/);
    }
  });

  it("says what the switch does and warns that group chats read other bots and web pages", () => {
    expect(GROUP_CHAT_TOOLS_TITLE).toBe("Group chats: full tools");
    expect(GROUP_CHAT_TOOLS_HINT).toMatch(/only look things up/);
    expect(GROUP_CHAT_TOOLS_HINT).toMatch(/same tools as in their own chat/);
    expect(GROUP_CHAT_TOOLS_HINT).toMatch(/other bots' messages and web pages/);
    expect(GROUP_CHAT_TOOLS_HINT).toMatch(/no extra checks, at your own risk/);
    expect(GROUP_CHAT_TOOLS_HINT).toMatch(/only if you trust every bot/);
  });

  it("reads only a boolean fullTools from the plugin", () => {
    expect(parseGroupChatToolsAnswer({ fullTools: true })).toEqual({ fullTools: true });
    expect(parseGroupChatToolsAnswer({ fullTools: false })).toEqual({ fullTools: false });
    for (const bad of [null, undefined, "x", {}, { fullTools: "true" }, { fullTools: 1 }]) {
      expect(parseGroupChatToolsAnswer(bad)).toBeNull();
    }
  });

  it("shows the card off by default, only when connected and the plugin answered", () => {
    const base = { isPending: false, error: null };
    expect(
      getGroupChatToolsCardState({ ...base, isConnected: true, answer: { fullTools: false } }),
    ).toEqual({
      isVisible: true,
      isEnabled: false,
      isSwitchDisabled: false,
      loadingText: null,
      errorText: null,
    });
    expect(
      getGroupChatToolsCardState({ ...base, isConnected: true, answer: { fullTools: true } })
        .isEnabled,
    ).toBe(true);
    expect(getGroupChatToolsCardState({ ...base, isConnected: true, answer: null }).isVisible).toBe(
      false,
    );
    expect(
      getGroupChatToolsCardState({ ...base, isConnected: false, answer: { fullTools: true } })
        .isVisible,
    ).toBe(false);
  });

  it("disables the switch while saving and shows a failed save", () => {
    const pending = getGroupChatToolsCardState({
      isConnected: true,
      answer: { fullTools: false },
      isPending: true,
      error: null,
    });
    expect(pending.isSwitchDisabled).toBe(true);
    expect(pending.loadingText).toBe("Updating group chats…");
    expect(
      getGroupChatToolsCardState({
        isConnected: true,
        answer: { fullTools: false },
        isPending: false,
        error: new Error("not a JSON object"),
      }).errorText,
    ).toBe("not a JSON object");
  });
});
