import { describe, expect, it } from "vitest";
import { classifyImageUri, imageFileExtension, imageSaveFileName } from "./image-save";

describe("classifyImageUri", () => {
  it("reads a base64 data URI", () => {
    expect(classifyImageUri("data:image/png;base64,iVBORw0K")).toEqual({
      kind: "data",
      mimeType: "image/png",
      base64: "iVBORw0K",
    });
  });

  it("tells files, blobs and remote URLs apart", () => {
    expect(classifyImageUri("file:///cache/paseo-chat-thumbs/a.jpg")?.kind).toBe("file");
    expect(classifyImageUri("/var/mobile/a.png")?.kind).toBe("file");
    expect(classifyImageUri("blob:http://localhost/123")?.kind).toBe("blob");
    expect(classifyImageUri("https://example.com/a.png")?.kind).toBe("remote");
    expect(classifyImageUri("content://media/1")).toBeNull();
  });
});

describe("imageFileExtension", () => {
  it("prefers the MIME type, then a data URI's type, then the path", () => {
    expect(imageFileExtension({ uri: "file:///x/a.jpg", mimeType: "image/png" })).toBe("png");
    expect(imageFileExtension({ uri: "data:image/webp;base64,AAAA" })).toBe("webp");
    expect(imageFileExtension({ uri: "file:///x/photo.HEIC" })).toBe("heic");
    expect(imageFileExtension({ uri: "https://x/a.jpeg?size=2" })).toBe("jpg");
    expect(imageFileExtension({ uri: "file:///x/blobfile" })).toBe("jpg");
  });
});

describe("imageSaveFileName", () => {
  it("names the file by time with the right extension", () => {
    const at = new Date(2026, 10, 19, 15, 30, 12);
    expect(imageSaveFileName({ uri: "data:image/png;base64,AA" }, at)).toBe(
      "image-20261119-153012.png",
    );
  });
});
