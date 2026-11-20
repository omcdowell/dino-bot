import { describe, expect, it } from "vitest";
import {
  normalizePickedImageAssetsWith,
  planPickedImage,
  PICKED_IMAGE_MAX_EDGE,
  type PickedImagePlan,
  type TranscodePickedImage,
} from "./picked-image-normalizer";

function fakeTranscode(): {
  transcode: TranscodePickedImage;
  calls: Array<{ uri: string; plan: PickedImagePlan }>;
} {
  const calls: Array<{ uri: string; plan: PickedImagePlan }> = [];
  return {
    transcode: async (uri, plan) => {
      calls.push({ uri, plan });
      return `file:///cache/ImageManipulator/out-${calls.length}.${plan.format.extension}`;
    },
    calls,
  };
}

describe("native image attachment picker", () => {
  it("keeps JPEG and PNG that already fit, untouched", async () => {
    const { transcode, calls } = fakeTranscode();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/IMG_0001.JPG",
          mimeType: "image/jpeg",
          fileName: "picked.jpeg",
          width: 1600,
          height: 1200,
        },
        {
          uri: "file:///photos/screenshot.png",
          mimeType: "image/png",
          fileName: "screenshot.png",
        },
      ],
      transcode,
    );

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///photos/IMG_0001.JPG" },
        mimeType: "image/jpeg",
        fileName: "picked.jpg",
      },
      {
        source: { kind: "file_uri", uri: "file:///photos/screenshot.png" },
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("uses explicit native MIME metadata before the URI extension", async () => {
    const { transcode, calls } = fakeTranscode();

    const result = await normalizePickedImageAssetsWith(
      [{ uri: "file:///photos/screenshot.jpg", mimeType: "image/png", fileName: "screenshot.png" }],
      transcode,
    );

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///photos/screenshot.jpg" },
        mimeType: "image/png",
        fileName: "screenshot.png",
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("scales a full-size camera photo down to the max edge, as JPEG", async () => {
    const { transcode, calls } = fakeTranscode();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/IMG_0002.JPG",
          mimeType: "image/jpeg",
          fileName: "IMG_0002.JPG",
          width: 4032,
          height: 3024,
        },
        {
          uri: "file:///photos/IMG_0003.JPG",
          mimeType: "image/jpeg",
          fileName: "IMG_0003.JPG",
          width: 3024,
          height: 4032,
        },
      ],
      transcode,
    );

    expect(calls.map((call) => call.plan)).toEqual([
      {
        kind: "transcode",
        format: { mimeType: "image/jpeg", extension: "jpg" },
        resize: { width: PICKED_IMAGE_MAX_EDGE },
      },
      {
        kind: "transcode",
        format: { mimeType: "image/jpeg", extension: "jpg" },
        resize: { height: PICKED_IMAGE_MAX_EDGE },
      },
    ]);
    expect(result.map((input) => [input.source, input.mimeType, input.fileName])).toEqual([
      [
        { kind: "file_uri", uri: "file:///cache/ImageManipulator/out-1.jpg" },
        "image/jpeg",
        "IMG_0002.jpg",
      ],
      [
        { kind: "file_uri", uri: "file:///cache/ImageManipulator/out-2.jpg" },
        "image/jpeg",
        "IMG_0003.jpg",
      ],
    ]);
  });

  it("turns a HEIC photo into a scaled JPEG, never a full-size PNG", async () => {
    const { transcode, calls } = fakeTranscode();

    const result = await normalizePickedImageAssetsWith(
      [
        {
          uri: "file:///photos/IMG_0001.HEIC",
          mimeType: "image/heic",
          fileName: "IMG_0001.HEIC",
          width: 5712,
          height: 4284,
        },
      ],
      transcode,
    );

    expect(calls).toEqual([
      {
        uri: "file:///photos/IMG_0001.HEIC",
        plan: {
          kind: "transcode",
          format: { mimeType: "image/jpeg", extension: "jpg" },
          resize: { width: PICKED_IMAGE_MAX_EDGE },
        },
      },
    ]);
    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///cache/ImageManipulator/out-1.jpg" },
        mimeType: "image/jpeg",
        fileName: "IMG_0001.jpg",
      },
    ]);
  });

  it("keeps a large PNG a PNG (screenshots), only smaller", () => {
    expect(
      planPickedImage({
        uri: "file:///photos/shot.png",
        mimeType: "image/png",
        width: 1320,
        height: 2868,
      }),
    ).toEqual({
      kind: "transcode",
      format: { mimeType: "image/png", extension: "png" },
      resize: { height: PICKED_IMAGE_MAX_EDGE },
    });
  });

  it("re-encodes an unknown format without a resize when its size is unknown", () => {
    expect(planPickedImage({ uri: "file:///photos/IMG.HEIC", mimeType: "image/heic" })).toEqual({
      kind: "transcode",
      format: { mimeType: "image/jpeg", extension: "jpg" },
      resize: null,
    });
  });

  it("transcodes one photo at a time", async () => {
    let running = 0;
    let maxRunning = 0;
    const transcode: TranscodePickedImage = async (uri) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return `${uri}.jpg`;
    };
    const assets = Array.from({ length: 5 }, (_, i) => ({
      uri: `file:///photos/IMG_${i}.HEIC`,
      width: 4032,
      height: 3024,
    }));
    const result = await normalizePickedImageAssetsWith(assets, transcode);
    expect(maxRunning).toBe(1);
    expect(result.map((input) => input.source)).toEqual(
      assets.map((asset) => ({ kind: "file_uri", uri: `${asset.uri}.jpg` })),
    );
  });
});
