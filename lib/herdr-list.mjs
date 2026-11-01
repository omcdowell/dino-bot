// `herdr session list` through the ~/.<id>/bin/herdr wrapper when short sockets are in use:
// herdr reports its default socket path for the session (too long to bind, and "running": false),
// so this replaces our session's socket_path with the short one and checks it really answers.
//   node herdr-list.mjs <real herdr> <session> session list [args...]   (HERDR_SOCKET_PATH set)
import { execFileSync } from "node:child_process";
import net from "node:net";

const [realBin, session, ...args] = process.argv.slice(2);
const sock = process.env.HERDR_SOCKET_PATH;
let out;
try {
  out = execFileSync(realBin, args, { encoding: "utf8", env: process.env });
} catch (e) {
  process.stderr.write(String(e.stderr ?? e.message));
  process.exit(typeof e.status === "number" ? e.status : 1);
}
if (!args.includes("--json") || !sock) {
  process.stdout.write(out);
} else {
  const alive = await new Promise((resolve) => {
    const s = net.connect(sock, () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
  const parsed = JSON.parse(out);
  const list = parsed?.sessions ?? parsed?.result?.sessions ?? [];
  let entry = list.find((x) => x.name === session);
  if (!entry) list.push((entry = { default: false, name: session }));
  entry.socket_path = sock;
  entry.running = alive;
  process.stdout.write(`${JSON.stringify(parsed)}\n`);
}
