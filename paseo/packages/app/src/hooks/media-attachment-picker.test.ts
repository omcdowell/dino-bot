import { describe, expect, it } from "vitest";
import {
  isVideoAsset,
  maxUploadBytesFor,
  splitPickedMediaAssets,
  videoAssetToSelectedFile,
  VIDEO_MAX_BYTES,
} from "./media-attachment-picker";

describe("media attachment picker", () => {
  it("splits library picks into images and videos", () => {
    const photo = { uri: "file:///p/IMG_1.HEIC", type: "image", mimeType: "image/heic" };
    const live = { uri: "file:///p/IMG_2.JPG", type: "livePhoto", mimeType: "image/jpeg" };
    const clip = { uri: "file:///p/IMG_3.MOV", type: "video", mimeType: "video/quicktime" };
    const untyped = { uri: "file:///p/x.mp4", mimeType: "video/mp4" };
    expect(splitPickedMediaAssets([photo, clip, live, untyped])).toEqual({
      images: [photo, live],
      videos: [clip, untyped],
    });
    expect(
      isVideoAsset({ uri: "blob:x", file: new File([], "a.webm", { type: "video/webm" }) }),
    ).toBe(true);
  });

  it("turns a picked video into a file to upload, with its size known before reading", async () => {
    const reads: string[] = [];
    const file = videoAssetToSelectedFile(
      {
        uri: "file:///cache/ImagePicker/ABC.MOV",
        type: "video",
        mimeType: "video/quicktime",
        fileName: "IMG_0042.MOV",
        fileSize: 12_345,
        duration: 8_250.4,
      },
      async (uri) => {
        reads.push(uri);
        return new Uint8Array([1]);
      },
    );
    expect(file).toMatchObject({
      fileName: "IMG_0042.MOV",
      mimeType: "video/quicktime",
      size: 12_345,
      durationMs: 8_250,
    });
    expect(reads).toEqual([]);
    await file.readBytes();
    expect(reads).toEqual(["file:///cache/ImagePicker/ABC.MOV"]);
  });

  it("names a video with no file name from its uri, or a generic name", () => {
    const read = async () => new Uint8Array();
    expect(
      videoAssetToSelectedFile({ uri: "file:///cache/7F2A.mov", type: "video" }, read),
    ).toMatchObject({ fileName: "7F2A.mov", mimeType: "video/quicktime" });
    expect(
      videoAssetToSelectedFile({ uri: "ph://ABCD", type: "video", mimeType: "video/mp4" }, read),
    ).toMatchObject({ fileName: "video.mp4", mimeType: "video/mp4" });
  });

  it("caps videos at 200 MB and other files at 50 MB", () => {
    expect(VIDEO_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(maxUploadBytesFor("video/quicktime")).toEqual({
      bytes: VIDEO_MAX_BYTES,
      label: "200 MB",
    });
    expect(maxUploadBytesFor("application/pdf")).toEqual({
      bytes: 50 * 1024 * 1024,
      label: "50MB",
    });
  });
});
