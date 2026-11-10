// @ts-nocheck -- dev-only web harness: built with a Paseo checkout's react-native-web (build.mjs), not this package's.
// Web harness stand-in for the `react-native` module the Paseo app hands plugin bundles
// (paseo/packages/app/src/plugins/react-native/scroll-top-inset.tsx): the real module, but its ScrollView leaves
// the host's top room (on the phone home: the top bar and its fade) above a vertical scroll's content. Off iOS
// the host adds it as top padding, as here. The room comes from `?hostInset=<pt>` (default 0), so the harness
// shows what the designer looks like when it opens from a sheet on the phone home.
import { createContext, createElement, forwardRef, useContext } from "react";
import * as RN from "react-native";

const inset = Number(new URLSearchParams(globalThis.location?.search ?? "").get("hostInset") ?? 0) || 0;
const Ctx = createContext(inset);

const InsetScrollView = forwardRef(function InsetScrollView(props, ref) {
  const top = useContext(Ctx);
  if (top <= 0 || props.horizontal) return createElement(RN.ScrollView, { ...props, ref });
  return createElement(
    Ctx.Provider,
    { value: 0 },
    createElement(RN.ScrollView, { ...props, contentContainerStyle: [props.contentContainerStyle, { paddingTop: top }], ref }),
  );
});

export * from "react-native";
export const ScrollView = InsetScrollView;
