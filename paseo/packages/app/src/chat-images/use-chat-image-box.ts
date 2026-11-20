import { useCallback, useMemo, useState } from "react";
import { useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { chatImageBox, type ChatImageBox, type ChatImageDimensions } from "./sizing";

/** Guess for the slot's width before it is measured (phone chat side padding). */
const UNMEASURED_INSET = 32;

/**
 * The image's box for its slot in the chat. Put `onLayout` on a full-width wrapper: its width is
 * the space the image may take. Before the first layout the window width is used as a guess.
 */
export function useChatImageBox(image: ChatImageDimensions): {
  box: ChatImageBox;
  onLayout: (event: LayoutChangeEvent) => void;
} {
  const viewport = useWindowDimensions();
  const [slotWidth, setSlotWidth] = useState<number | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.floor(event.nativeEvent.layout.width);
    if (width > 0) setSlotWidth((current) => (current === width ? current : width));
  }, []);
  const space = slotWidth ?? Math.max(1, viewport.width - UNMEASURED_INSET);
  const imageWidth = image.width;
  const imageHeight = image.height;
  const imageAspectRatio = image.aspectRatio;
  const box = useMemo(
    () =>
      chatImageBox(
        { width: imageWidth, height: imageHeight, aspectRatio: imageAspectRatio },
        { width: space, screenHeight: viewport.height },
      ),
    [imageAspectRatio, imageHeight, imageWidth, space, viewport.height],
  );
  return { box, onLayout };
}
