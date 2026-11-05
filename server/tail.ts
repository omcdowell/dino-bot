import { open } from "node:fs/promises";

/** Whole lines from the last `limit` bytes of a file (none if it does not exist). A cut first line is dropped. */
export async function tailLines(path: string, limit: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim());
  } finally {
    await handle.close();
  }
}
