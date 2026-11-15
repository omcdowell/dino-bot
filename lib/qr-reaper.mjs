// The pairing picture's reaper (lib/qr.mjs startQrReaper): a detached process in its own session
// that removes the picture at its deadline if it is still the same file, then ends. It ends early
// when the picture is gone or replaced (a newer QR has its own reaper).
// node qr-reaper.mjs <path> <inode> <mtimeMs> <deadline epoch ms> [pollMs]
import { statSync } from "node:fs";
import { removeIfSameFile } from "./qr.mjs";

const [path, ino, mtimeMs, deadlineArg, pollArg] = process.argv.slice(2);
const deadline = Number(deadlineArg);
const pollMs = Math.max(50, Number(pollArg) || 30_000);
process.on("SIGHUP", () => {}); // the terminal closing is not our end

function same() {
  try {
    const st = statSync(path);
    return String(st.ino) === ino && Math.floor(st.mtimeMs) === Number(mtimeMs);
  } catch {
    return false;
  }
}

async function main() {
  if (!path || !Number.isFinite(deadline)) return;
  for (;;) {
    if (!same()) return;
    const left = deadline - Date.now(); // wall clock: a Mac that slept past the deadline ends at once
    if (left <= 0) {
      removeIfSameFile(path, ino, mtimeMs);
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(left, pollMs)));
  }
}
await main();
