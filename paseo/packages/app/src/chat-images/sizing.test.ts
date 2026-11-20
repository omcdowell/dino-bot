import { describe, expect, it } from "vitest";
import {
  CHAT_IMAGE_MAX_HEIGHT,
  CHAT_IMAGE_MAX_WIDTH,
  CHAT_IMAGE_MIN_HEIGHT_CAP,
  CHAT_IMAGE_MIN_SIDE,
  chatImageBox,
  formatImageBytes,
} from "./sizing";

/** iPhone 17 Pro: 402 x 874 pt window; a user image slot is about 370 pt wide. */
const PHONE = { width: 370, screenHeight: 874 };
const PHONE_MAX_HEIGHT = Math.round(874 * 0.6); // 524
/** A laptop chat column. */
const LAPTOP = { width: 900, screenHeight: 1000 };

describe("chatImageBox", () => {
  it("shows a portrait phone screenshot whole, at its own ratio, 60% of the screen tall", () => {
    const box = chatImageBox({ width: 1206, height: 2622 }, PHONE);
    expect(box.height).toBe(PHONE_MAX_HEIGHT);
    expect(box.width).toBe(Math.round(PHONE_MAX_HEIGHT * (1206 / 2622))); // 241
    expect(box.width / box.height).toBeCloseTo(1206 / 2622, 2);
    expect(box.letterboxed).toBe(false);
  });

  it("shows a landscape photo at the slot's width", () => {
    const box = chatImageBox({ width: 4032, height: 3024 }, PHONE);
    expect(box).toEqual({
      width: 370,
      height: 278,
      imageAspectRatio: 4032 / 3024,
      letterboxed: false,
    });
  });

  it("caps the width on a laptop and the height at the fixed maximum", () => {
    expect(chatImageBox({ width: 4032, height: 3024 }, LAPTOP)).toMatchObject({
      width: CHAT_IMAGE_MAX_WIDTH,
      height: 360,
    });
    const portrait = chatImageBox({ width: 3024, height: 4032 }, LAPTOP);
    expect(portrait.height).toBe(CHAT_IMAGE_MAX_HEIGHT);
    expect(portrait.width).toBe(CHAT_IMAGE_MAX_HEIGHT * 0.75);
  });

  it("letterboxes a panorama in a 3:1 box", () => {
    const box = chatImageBox({ width: 8000, height: 1000 }, PHONE);
    expect(box).toMatchObject({ width: 370, height: 123, letterboxed: true });
  });

  it("letterboxes a very tall image in a 1:3 box", () => {
    const box = chatImageBox({ width: 1080, height: 10800 }, PHONE);
    expect(box).toMatchObject({ width: 175, height: PHONE_MAX_HEIGHT, letterboxed: true });
  });

  it("keeps a tiny image tappable without blowing small images past their own size", () => {
    expect(chatImageBox({ width: 32, height: 32 }, PHONE)).toMatchObject({
      width: CHAT_IMAGE_MIN_SIDE,
      height: CHAT_IMAGE_MIN_SIDE,
    });
    expect(chatImageBox({ width: 60, height: 20 }, PHONE)).toMatchObject({
      width: 288,
      height: CHAT_IMAGE_MIN_SIDE,
    });
    // Small but above the minimum: its own pixel size, not the slot's width.
    expect(chatImageBox({ width: 200, height: 150 }, PHONE)).toMatchObject({
      width: 200,
      height: 150,
    });
  });

  it("never lets the height cap fall below its floor on a short window", () => {
    const box = chatImageBox({ width: 1206, height: 2622 }, { width: 700, screenHeight: 300 });
    expect(box.height).toBe(CHAT_IMAGE_MIN_HEIGHT_CAP);
  });

  it("uses 4:3 at the slot's width when the size is unknown, or a bare aspect ratio", () => {
    expect(chatImageBox({}, PHONE)).toMatchObject({ width: 370, height: 278 });
    expect(chatImageBox({ aspectRatio: 0.5 }, PHONE)).toMatchObject({
      width: 262,
      height: PHONE_MAX_HEIGHT,
    });
  });

  it("never crops: inside 1:3..3:1 the box has the image's ratio and fits every limit", () => {
    for (const space of [PHONE, LAPTOP, { width: 250, screenHeight: 600 }]) {
      for (const [w, h] of [
        [1206, 2622],
        [2622, 1206],
        [3000, 1000],
        [1000, 3000],
        [640, 480],
        [1920, 1080],
        [500, 500],
      ] as const) {
        const box = chatImageBox({ width: w, height: h }, space);
        // Only the minimum size may change the shape (250 pt slot, 3:1 image: 250 x 96).
        if (box.letterboxed) {
          expect(Math.min(box.width, box.height)).toBe(CHAT_IMAGE_MIN_SIDE);
          continue;
        }
        // Rounding to whole points moves the ratio by under one point on either side.
        expect(Math.abs(box.width - box.height * (w / h))).toBeLessThanOrEqual(1);
        expect(box.width).toBeLessThanOrEqual(Math.min(space.width, CHAT_IMAGE_MAX_WIDTH));
        expect(box.height).toBeLessThanOrEqual(CHAT_IMAGE_MAX_HEIGHT);
      }
    }
  });
});

describe("formatImageBytes", () => {
  it("formats sizes", () => {
    expect(formatImageBytes(512)).toBe("512 B");
    expect(formatImageBytes(200 * 1024)).toBe("200 KB");
    expect(formatImageBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatImageBytes(null)).toBeNull();
  });
});
