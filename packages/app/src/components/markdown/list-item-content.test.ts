import { describe, expect, it } from "vitest";
import type { ViewStyle } from "react-native";
import { MARKDOWN_LIST_ITEM_CONTENT_FLEX } from "./list-item-content";

// The theme's bullet_list_content / ordered_list_content (styles/markdown-styles.ts). The renderer
// applies [contentStyle, MARKDOWN_LIST_ITEM_CONTENT_FLEX], so the constant wins key by key.
const THEME_LIST_CONTENT: ViewStyle = { flex: 1, flexShrink: 1 };

// Yoga's Node::processFlexBasis (react-native/ReactCommon/yoga/yoga/node/Node.cpp), native
// defaults: an explicit non-auto basis wins; otherwise any flex > 0 means basis 0; else auto.
function yogaFlexBasis(style: ViewStyle): "auto" | number | string {
  const basis = style.flexBasis;
  if (basis !== undefined && basis !== "auto") return basis as number | string;
  if (typeof style.flex === "number" && style.flex > 0) return 0;
  return "auto";
}

describe("markdown list item content", () => {
  const merged: ViewStyle = {
    ...THEME_LIST_CONTENT,
    ...MARKDOWN_LIST_ITEM_CONTENT_FLEX,
  };

  it("sizes from its text, so a message that starts with a list does not collapse in a shrink-to-fit bubble", () => {
    // Before the fix this was 0: the group chat bubble measured a list-first message 0 wide.
    expect(yogaFlexBasis(merged)).toBe("auto");
  });

  it("still fills and wraps inside a fixed width (agent chat, file preview, PR comments)", () => {
    expect(merged.flexGrow).toBe(1);
    expect(merged.flexShrink).toBe(1);
    expect(merged.minWidth).toBe(0);
  });
});
