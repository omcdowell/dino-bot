"use strict";
// Decodes one PNG, JPEG or HEIC once and derives what the chat needs from it: JPEGs at a given
// size (the display image at chat width, legacy thumbnails, a full-size JPEG of a HEIC for
// clients that cannot show HEIC) and a ThumbHash placeholder (~25 bytes, blurred preview).
// Runs in a worker thread: decoding a 12 MP photo takes most of a second, which must not block
// the daemon's event loop. Plain CommonJS so it runs unchanged from src (vitest, tsx) and dist
// (copied by build:lib).
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { rgbaToThumbHash } = require("./thumbhash.cjs");

async function decode(bytes, format, maxPixels) {
  if (format === "png") {
    const { PNG } = require("pngjs");
    const png = PNG.sync.read(bytes);
    if (png.width * png.height > maxPixels) throw new Error("Image is too large to decode");
    return { width: png.width, height: png.height, data: png.data };
  }
  if (format === "jpeg") {
    const jpeg = require("jpeg-js");
    const image = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: Math.ceil(maxPixels / 1e6),
      maxMemoryUsageInMB: 1024,
    });
    return { width: image.width, height: image.height, data: image.data };
  }
  if (format === "heic") {
    // libheif (wasm) via heic-decode; applies the HEIF rotation/mirror itself.
    const decodeHeic = require("heic-decode");
    const image = await decodeHeic({ buffer: bytes });
    if (image.width * image.height > maxPixels) throw new Error("Image is too large to decode");
    return { width: image.width, height: image.height, data: image.data };
  }
  throw new Error("Unsupported image format");
}

// Box-filter downscale to (tw, th), compositing transparency over white.
function downscale(source, tw, th) {
  const { width: sw, height: sh, data } = source;
  const out = new Uint8Array(tw * th * 4);
  const xScale = sw / tw;
  const yScale = sh / th;
  for (let ty = 0; ty < th; ty += 1) {
    const y0 = Math.floor(ty * yScale);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((ty + 1) * yScale)));
    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = Math.floor(tx * xScale);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((tx + 1) * xScale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        let i = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          const a = data[i + 3] / 255;
          r += data[i] * a + 255 * (1 - a);
          g += data[i + 1] * a + 255 * (1 - a);
          b += data[i + 2] * a + 255 * (1 - a);
          n += 1;
          i += 4;
        }
      }
      const o = (ty * tw + tx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: tw, height: th, data: out };
}

// EXIF orientation 1..8 to display orientation.
function orient(image, orientation) {
  if (orientation <= 1 || orientation > 8) return image;
  const { width: w, height: h, data } = image;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8Array(ow * oh * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let dx;
      let dy;
      switch (orientation) {
        case 2:
          dx = w - 1 - x;
          dy = y;
          break;
        case 3:
          dx = w - 1 - x;
          dy = h - 1 - y;
          break;
        case 4:
          dx = x;
          dy = h - 1 - y;
          break;
        case 5:
          dx = y;
          dy = x;
          break;
        case 6:
          dx = h - 1 - y;
          dy = x;
          break;
        case 7:
          dx = h - 1 - y;
          dy = w - 1 - x;
          break;
        default:
          dx = y;
          dy = w - 1 - x;
          break;
      }
      const i = (y * w + x) * 4;
      const o = (dy * ow + dx) * 4;
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = data[i + 3];
    }
  }
  return { width: ow, height: oh, data: out };
}

/** Stored-pixel target size whose displayed (oriented) size fits the output's bounds. */
function targetSize(decoded, orientation, output) {
  const swap = orientation >= 5;
  const displayWidth = swap ? decoded.height : decoded.width;
  const displayHeight = swap ? decoded.width : decoded.height;
  let scale = 1;
  if (output.maxEdge)
    scale = Math.min(scale, output.maxEdge / Math.max(displayWidth, displayHeight));
  if (output.maxWidth) scale = Math.min(scale, output.maxWidth / displayWidth);
  if (output.maxHeight) scale = Math.min(scale, output.maxHeight / displayHeight);
  return {
    width: Math.max(1, Math.round(decoded.width * scale)),
    height: Math.max(1, Math.round(decoded.height * scale)),
  };
}

function resized(decoded, orientation, output) {
  const size = targetSize(decoded, orientation, output);
  const scaled =
    size.width === decoded.width && size.height === decoded.height
      ? decoded
      : downscale(decoded, size.width, size.height);
  return orient(scaled, orientation);
}

function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function run(input) {
  const bytes = fs.readFileSync(input.path);
  const decoded = await decode(bytes, input.format, input.maxPixels);
  const results = [];
  for (const output of input.outputs) {
    if (output.kind === "thumbhash") {
      const small = resized(decoded, input.orientation, { maxWidth: 100, maxHeight: 100 });
      const hash = rgbaToThumbHash(small.width, small.height, small.data);
      results.push({ kind: "thumbhash", thumbhash: Buffer.from(hash).toString("base64") });
      continue;
    }
    const image = resized(decoded, input.orientation, output);
    const jpeg = require("jpeg-js");
    const encoded = jpeg.encode(
      { width: image.width, height: image.height, data: image.data },
      output.quality,
    );
    const data = new Uint8Array(encoded.data);
    if (output.file) {
      writeAtomic(output.file, data);
      results.push({
        kind: "jpeg",
        file: output.file,
        width: image.width,
        height: image.height,
        byteSize: data.byteLength,
      });
    } else {
      results.push({
        kind: "jpeg",
        data,
        width: image.width,
        height: image.height,
        byteSize: data.byteLength,
      });
    }
  }
  return results;
}

run(workerData).then(
  (results) => {
    const transfer = results.flatMap((result) => (result.data ? [result.data.buffer] : []));
    return parentPort.postMessage({ ok: true, results }, transfer);
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    parentPort.postMessage({ ok: false, error: message }, []);
  },
);
