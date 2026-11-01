import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const ScrollView = () => null;
  const View = () => null;
  return { ScrollView, View, Platform: { OS: "ios" } };
});

const { InsetScrollView, pluginReactNative, resolveScrollTopInsetProps } =
  await import("./scroll-top-inset");
const RN = await import("react-native");

describe("resolveScrollTopInsetProps", () => {
  it("uses the native content inset on iOS and rests the content below it", () => {
    expect(resolveScrollTopInsetProps({ platform: "ios", inset: 178, props: {} })).toEqual({
      contentInset: { top: 178 },
      scrollIndicatorInsets: { top: 178 },
      contentOffset: { x: 0, y: -178 },
      automaticallyAdjustContentInsets: false,
      contentInsetAdjustmentBehavior: "never",
    });
  });

  it("adds to the plugin's own insets and keeps its offset", () => {
    const props = resolveScrollTopInsetProps({
      platform: "ios",
      inset: 100,
      props: { contentInset: { top: 10, bottom: 5 }, contentOffset: { x: 0, y: 40 } },
    });
    expect(props.contentInset).toEqual({ top: 110, bottom: 5 });
    expect(props.contentOffset).toEqual({ x: 0, y: 40 });
  });

  it("pads the content on Android and web, keeping the plugin's content style", () => {
    const own = { paddingBottom: 40 };
    expect(
      resolveScrollTopInsetProps({
        platform: "android",
        inset: 178,
        props: { contentContainerStyle: own },
      }),
    ).toEqual({ contentContainerStyle: [own, { paddingTop: 178 }] });
  });
});

describe("pluginReactNative", () => {
  it("swaps in the inset-aware ScrollView and passes everything else through", () => {
    expect(pluginReactNative.ScrollView).toBe(InsetScrollView);
    expect(pluginReactNative.View).toBe(RN.View);
    expect(pluginReactNative.Platform).toBe(RN.Platform);
  });
});
