import { useMemo } from "react";
import { Image, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { APP_DISPLAY_NAME } from "@/constants/flavour";
import { dinoLineSvg } from "./dino-line-svg";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

// Dino line art (Flint, out/v4 dino-lineart-white): drawn in `color` (theme foreground by default),
// so it shows black lines on light backgrounds and white lines on dark ones.
// Native: the white PNG tinted with `tintColor`. Web: react-native-web ignores `tintColor`, so the
// colour fills a View masked by the same art as SVG.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DINO_LINE = require("../../../assets/images/dino-line.png");
const DINO_MASK = `url("data:image/svg+xml,${encodeURIComponent(dinoLineSvg(1024))}")`;

export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const tint = color ?? theme.colors.foreground;
  const imageStyle = useMemo(() => ({ width: size, height: size, tintColor: tint }), [size, tint]);
  const maskStyle = useMemo(
    () => ({
      width: size,
      height: size,
      backgroundColor: tint,
      maskImage: DINO_MASK,
      WebkitMaskImage: DINO_MASK,
      maskSize: "contain",
      WebkitMaskSize: "contain",
      maskRepeat: "no-repeat",
      WebkitMaskRepeat: "no-repeat",
    }),
    [size, tint],
  );

  if (isWeb) {
    return (
      <View style={maskStyle as never} accessibilityLabel={APP_DISPLAY_NAME} testID="paseo-logo" />
    );
  }

  return (
    <Image
      source={DINO_LINE}
      style={imageStyle}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      testID="paseo-logo"
    />
  );
}
