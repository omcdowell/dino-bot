/**
 * Reads an image's format, pixel size and EXIF orientation from its header, without decoding.
 * Chat image references carry the display size so clients reserve layout space before the
 * thumbnail arrives.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "heic";

export interface ImageHeader {
  format: ImageFormat;
  mimeType: string;
  /** Stored pixel size. */
  pixelWidth: number;
  pixelHeight: number;
  /** EXIF orientation 1..8 (1 when absent). 5..8 swap width and height on display. */
  orientation: number;
  /** Display size, after orientation. */
  width: number;
  height: number;
}

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
};

export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed =
    readPng(buffer) ?? readJpeg(buffer) ?? readGif(buffer) ?? readWebp(buffer) ?? readHeif(buffer);
  if (!parsed || parsed.pixelWidth <= 0 || parsed.pixelHeight <= 0) return null;
  const orientation = parsed.orientation >= 1 && parsed.orientation <= 8 ? parsed.orientation : 1;
  const swap = orientation >= 5;
  return {
    format: parsed.format,
    mimeType: MIME_BY_FORMAT[parsed.format],
    pixelWidth: parsed.pixelWidth,
    pixelHeight: parsed.pixelHeight,
    orientation,
    width: swap ? parsed.pixelHeight : parsed.pixelWidth,
    height: swap ? parsed.pixelWidth : parsed.pixelHeight,
  };
}

interface RawHeader {
  format: ImageFormat;
  pixelWidth: number;
  pixelHeight: number;
  orientation: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(buffer: Buffer): RawHeader | null {
  if (buffer.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  return {
    format: "png",
    pixelWidth: buffer.readUInt32BE(16),
    pixelHeight: buffer.readUInt32BE(20),
    orientation: 1,
  };
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(buffer: Buffer): RawHeader | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return null;
    const segmentStart = offset + 4;
    if (marker === 0xe1) {
      orientation = readExifOrientation(buffer, segmentStart, offset + 2 + length) ?? orientation;
    }
    if (isStartOfFrame(marker) && length >= 7) {
      return {
        format: "jpeg",
        pixelHeight: buffer.readUInt16BE(segmentStart + 1),
        pixelWidth: buffer.readUInt16BE(segmentStart + 3),
        orientation,
      };
    }
    offset += 2 + length;
  }
  return null;
}

function readExifOrientation(buffer: Buffer, start: number, end: number): number | null {
  if (end - start < 14 || buffer.toString("latin1", start, start + 4) !== "Exif") return null;
  const tiff = start + 6;
  const byteOrder = buffer.toString("latin1", tiff, tiff + 2);
  const little = byteOrder === "II";
  if (!little && byteOrder !== "MM") return null;
  const u16 = (at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
  const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

function readGif(buffer: Buffer): RawHeader | null {
  if (buffer.length < 10) return null;
  const signature = buffer.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return {
    format: "gif",
    pixelWidth: buffer.readUInt16LE(6),
    pixelHeight: buffer.readUInt16LE(8),
    orientation: 1,
  };
}

// HEIF brands for still images (iPhone photos are `heic`; `mif1` is the generic HEIF brand).
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

interface IsoBox {
  type: string;
  /** First byte after the box header. */
  start: number;
  end: number;
}

function readBoxes(buffer: Buffer, start: number, end: number): IsoBox[] {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    boxes.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

/**
 * HEIC/HEIF: the size is the `ispe` property of the primary item and the display rotation its
 * `irot` property (decoders apply it, so it is folded into the size here, orientation stays 1).
 * iPhone photos are a grid item whose `ispe` is the full picture.
 */
// oxlint-disable-next-line complexity -- a flat walk of the few HEIF boxes we need
function readHeif(buffer: Buffer): RawHeader | null {
  if (buffer.length < 16 || buffer.toString("latin1", 4, 8) !== "ftyp") return null;
  const top = readBoxes(buffer, 0, buffer.length);
  const ftyp = top.find((box) => box.type === "ftyp");
  if (!ftyp) return null;
  const brands = [buffer.toString("latin1", ftyp.start, ftyp.start + 4)];
  for (let at = ftyp.start + 8; at + 4 <= ftyp.end; at += 4) {
    brands.push(buffer.toString("latin1", at, at + 4));
  }
  if (!brands.some((brand) => HEIF_BRANDS.has(brand))) return null;
  const meta = top.find((box) => box.type === "meta");
  if (!meta) return null;
  const metaChildren = readBoxes(buffer, meta.start + 4, meta.end);
  const pitm = metaChildren.find((box) => box.type === "pitm");
  const iprp = metaChildren.find((box) => box.type === "iprp");
  if (!iprp) return null;
  let primaryId: number | null = null;
  if (pitm) {
    primaryId =
      buffer[pitm.start] === 0
        ? buffer.readUInt16BE(pitm.start + 4)
        : buffer.readUInt32BE(pitm.start + 4);
  }
  const iprpChildren = readBoxes(buffer, iprp.start, iprp.end);
  const ipco = iprpChildren.find((box) => box.type === "ipco");
  if (!ipco) return null;
  const properties = readBoxes(buffer, ipco.start, ipco.end);
  const associated = new Set<number>();
  for (const ipma of iprpChildren.filter((box) => box.type === "ipma")) {
    const version = buffer[ipma.start];
    const wideIndex = (buffer[ipma.start + 3] & 1) === 1;
    let at = ipma.start + 4;
    const entries = buffer.readUInt32BE(at);
    at += 4;
    for (let entry = 0; entry < entries && at < ipma.end; entry += 1) {
      const itemId = version < 1 ? buffer.readUInt16BE(at) : buffer.readUInt32BE(at);
      at += version < 1 ? 2 : 4;
      const count = buffer[at];
      at += 1;
      for (let i = 0; i < count; i += 1) {
        const index = wideIndex ? buffer.readUInt16BE(at) & 0x7fff : buffer[at] & 0x7f;
        at += wideIndex ? 2 : 1;
        if (itemId === primaryId && index > 0) associated.add(index - 1);
      }
    }
  }
  const forPrimary = properties.filter((_, index) => associated.has(index));
  const ispe =
    forPrimary.find((box) => box.type === "ispe") ??
    properties
      .filter((box) => box.type === "ispe")
      .sort((a, b) => buffer.readUInt32BE(b.start + 4) - buffer.readUInt32BE(a.start + 4))[0];
  if (!ispe || ispe.end - ispe.start < 12) return null;
  const storedWidth = buffer.readUInt32BE(ispe.start + 4);
  const storedHeight = buffer.readUInt32BE(ispe.start + 8);
  const irot = forPrimary.find((box) => box.type === "irot");
  const quarterTurns = irot ? buffer[irot.start] & 3 : 0;
  const swap = quarterTurns % 2 === 1;
  return {
    format: "heic",
    pixelWidth: swap ? storedHeight : storedWidth,
    pixelHeight: swap ? storedWidth : storedHeight,
    orientation: 1,
  };
}

function readWebp(buffer: Buffer): RawHeader | null {
  if (buffer.length < 30) return null;
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = buffer.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return {
      format: "webp",
      pixelWidth: 1 + buffer.readUIntLE(24, 3),
      pixelHeight: 1 + buffer.readUIntLE(27, 3),
      orientation: 1,
    };
  }
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      format: "webp",
      pixelWidth: 1 + (bits & 0x3fff),
      pixelHeight: 1 + ((bits >> 14) & 0x3fff),
      orientation: 1,
    };
  }
  if (chunk === "VP8 ") {
    return {
      format: "webp",
      pixelWidth: buffer.readUInt16LE(26) & 0x3fff,
      pixelHeight: buffer.readUInt16LE(28) & 0x3fff,
      orientation: 1,
    };
  }
  return null;
}
