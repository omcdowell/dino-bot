import type { ViewStyle } from "react-native";

// The text column beside a list marker. It must size from its content (flexBasis auto), not from
// zero: `flex: 1` makes Yoga's basis 0 on native, so in a shrink-to-fit parent (a group chat
// bubble) a message that STARTS with a list measured 0 wide and its text ran down one letter per
// line. `flex: 0` cancels the `flex: 1` in the theme's *_list_content style (Yoga reads basis 0
// from any flex > 0 even with flexBasis auto set); grow/shrink still fill and wrap in a fixed width.
export const MARKDOWN_LIST_ITEM_CONTENT_FLEX: ViewStyle = {
  flex: 0,
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: "auto",
  minWidth: 0,
};
