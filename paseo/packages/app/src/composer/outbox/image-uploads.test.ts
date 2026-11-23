import { describe, expect, test } from "vitest";
import { MAX_WS_FRAME_BYTES } from "@getpaseo/protocol/ws-frame-limit";
import { INLINE_IMAGES_MAX_BYTES } from "./image-uploads";

describe("inline photo frame budget", () => {
  test("the largest inline-photo message fits the daemon's frame limit on an encrypted link", () => {
    // base64 of the photos (4/3), then base64 of the ciphertext on an encrypted link (4/3 again),
    // plus 1 MiB for the JSON envelope and text.
    const largestFrame = (INLINE_IMAGES_MAX_BYTES * 16) / 9 + 1024 * 1024;
    expect(largestFrame).toBeLessThan(MAX_WS_FRAME_BYTES);
  });
});
