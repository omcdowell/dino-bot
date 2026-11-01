// Windows: DinoBot runs inside WSL 2 (Ubuntu). This file detects WSL and holds the WSL-only advice:
// systemd or not, the Tailscale route (inside Ubuntu, or Windows' own Tailscale with mirrored
// networking), Windows drives (/mnt/c), keeping Ubuntu running with no window open, dictation.
//
// Networking (windows-wsl, 30 Oct): WSL 2 is NAT'd by default, so a service inside Ubuntu cannot be
// reached on Windows' tailnet address. Recommended: Tailscale inside Ubuntu (its own tailnet
// address; no admin steps on Windows; same path as plain Linux). Also supported: Tailscale on
// Windows with `networkingMode=mirrored` (Windows 11 22H2+), where Ubuntu sees Windows' tailnet
// address and can listen on it (the Hyper-V firewall must allow the port). `netsh portproxy` is
// documented only (admin, the WSL address changes at every boot, and the daemon would have to
// listen on a non-tailnet address). Never 0.0.0.0.
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { PRODUCT, PRODUCT_ID, run, writeFileAtomic } from "./util.mjs";

/** Where Tailscale for Windows puts its CLI, seen from WSL (drive C: is mounted at /mnt/c). */
export const WINDOWS_TAILSCALE = "/mnt/c/Program Files/Tailscale/tailscale.exe";
/** DINOBOT_WINDOWS_TAILSCALE: another path (tests, Tailscale installed elsewhere). */
export const windowsTailscalePath = (env = process.env) => env.DINOBOT_WINDOWS_TAILSCALE || WINDOWS_TAILSCALE;
/** The Hyper-V firewall's id for WSL (Microsoft's docs, mirrored mode networking). */
export const WSL_VM_CREATOR_ID = "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}";

/**
 * 0 (not WSL), 1 or 2, from /proc/version and WSL_DISTRO_NAME. WSL 2 kernels say
 * "microsoft-standard-WSL2"; WSL 1 says "…-Microsoft". A custom WSL 2 kernel may say neither, so
 * WSL_DISTRO_NAME (set by WSL in every shell) alone counts as WSL 2.
 */
export function wslVersion(procVersion = "", env = process.env) {
  if (/microsoft-standard|WSL2/i.test(procVersion)) return 2;
  if (/microsoft/i.test(procVersion)) return 1;
  return env.WSL_DISTRO_NAME ? 2 : 0;
}

/** A Windows drive mounted into WSL (/mnt/c/…): slow for many small files, and no Unix file modes. */
export function isWindowsDrivePath(p) {
  return /^\/mnt\/[a-z](\/|$)/i.test(String(p ?? ""));
}

/** `wslinfo --networking-mode` (WSL 2.0+), else the loopback0 interface that mirrored mode adds. */
export async function wslNetworkingMode({ exec = run, nets = os.networkInterfaces() } = {}) {
  const r = await exec("wslinfo", ["--networking-mode"], { timeout: 3000 });
  const m = r.code === 0 ? r.stdout.trim().toLowerCase() : "";
  if (m) return m;
  if (nets.loopback0) return "mirrored";
  return "unknown";
}

/** null when not on WSL; else what the rest of the installer needs to know about it. */
export async function detectWsl({ env = process.env, exists = existsSync, read = (p) => readFileSync(p, "utf8"), exec = run, nets = os.networkInterfaces(), uid = process.getuid?.() ?? 1000 } = {}) {
  if (process.platform !== "linux") return null;
  let pv = "";
  try {
    pv = read(env.DINOBOT_PROC_VERSION || "/proc/version"); // (override: tests, as in install.sh)
  } catch {}
  const version = wslVersion(pv, env);
  if (!version) return null;
  return {
    version,
    distro: env.WSL_DISTRO_NAME || null,
    systemd: exists("/run/systemd/system"),
    // `systemctl --user` needs the user's systemd instance (its bus). WSL starts it with a login
    // shell; a distro without dbus-user-session has systemd but no user bus.
    userBus: exists(`/run/user/${uid}/bus`),
    networking: await wslNetworkingMode({ exec, nets }),
    interop: exists("/proc/sys/fs/binfmt_misc/WSLInterop") || exists("/proc/sys/fs/binfmt_misc/WSLInterop-late"),
    windowsTailscale: exists(windowsTailscalePath(env)),
    // GPU passthrough: /dev/dxg (any GPU) and the Windows NVIDIA driver's CUDA library.
    gpu: exists("/dev/dxg"),
    cuda: exists("/usr/lib/wsl/lib/libcuda.so.1") || exists("/usr/lib/wsl/lib/libcuda.so"),
  };
}

/** Is `ip` one of this machine's own addresses (so the daemon can listen on it)? */
export function isLocalAddress(ip, nets = os.networkInterfaces()) {
  return Object.values(nets).some((list) => (list ?? []).some((a) => a.address === ip));
}

/** One line to turn on systemd in this distro (then WSL has to restart). */
export const ENABLE_SYSTEMD = "printf '[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf";

/**
 * Tailscale steps for WSL (pure; tailscaleSteps calls this). `tailscale.windows` = the Windows
 * Tailscale answered; `tailscale.local` = its address is usable inside Ubuntu (mirrored mode).
 */
export function wslTailscaleSteps(tailscale, wsl) {
  const lines = [];
  const step = (s) => lines.push(`${lines.filter((l) => /^\d\./.test(l)).length + 1}. ${s}`);
  const inside = () => {
    if (!wsl.systemd) {
      step(`Turn on systemd in Ubuntu (Tailscale needs it):   ${ENABLE_SYSTEMD}`);
      lines.push("   then in Windows PowerShell:   wsl --shutdown   and open Ubuntu again.");
    }
    step("Install Tailscale inside Ubuntu (this window):   curl -fsSL https://tailscale.com/install.sh | sh");
    step("Turn it on:   sudo tailscale up --operator=$USER   (then open the login link it prints)");
  };
  if (tailscale.windows && tailscale.running && !tailscale.local) {
    lines.push(`Tailscale is on in Windows, but Ubuntu runs behind WSL's own network (NAT), so your iPhone`);
    lines.push(`cannot reach ${PRODUCT} through Windows' Tailscale address. Recommended: Tailscale inside Ubuntu as well.`);
    lines.push("");
    inside();
    lines.push("");
    lines.push("(Windows 11 alternative: mirrored networking; see the Windows guide, docs/windows.md.)");
  } else if (!tailscale.installed || tailscale.windows) {
    lines.push(`One more thing first: ${PRODUCT} uses Tailscale (free) so your iPhone can reach this computer`);
    lines.push("from anywhere, privately, without opening anything to the internet. It takes about two minutes.");
    lines.push("");
    inside();
  } else if (tailscale.state === "NeedsLogin" || tailscale.state === "NoState") {
    lines.push("Tailscale is installed in Ubuntu but not logged in.");
    if (!wsl.systemd) lines.push(`(Ubuntu runs without systemd, so Tailscale's service is not running. Turn systemd on:   ${ENABLE_SYSTEMD}   then wsl --shutdown in PowerShell.)`);
    step("Run:   sudo tailscale up --operator=$USER   and open the login link it prints.");
  } else if (tailscale.state === "NeedsMachineAuth") {
    lines.push("Tailscale is waiting for this computer to be approved.");
    step("Approve it at https://login.tailscale.com/admin/machines");
  } else {
    lines.push(`Tailscale is installed in Ubuntu but off (${tailscale.state ?? "stopped"}).`);
    step("Run:   sudo tailscale up --operator=$USER");
  }
  return lines;
}

/** Hyper-V firewall rule for mirrored mode: the daemon port, tailnet addresses only. */
export function hyperVFirewallCommand(port) {
  return `New-NetFirewallHyperVRule -Name ${PRODUCT}-${port} -DisplayName "${PRODUCT} (WSL) ${port}" -Direction Inbound -Action Allow -VMCreatorId '${WSL_VM_CREATOR_ID}' -Protocol TCP -LocalPorts ${port} -RemoteAddresses 100.64.0.0/10`;
}

/** Summary lines after setup on WSL (pure). */
export function wslSetupNotes({ wsl, mode, port, tailscale, bin }) {
  const notes = [];
  if (!wsl) return notes;
  const dinobot = join(bin, PRODUCT_ID);
  notes.push(
    `Windows (WSL): Windows stops Ubuntu about 15 seconds after its last window closes, and your bots with it. To keep them reachable from your phone, run once:  ${dinobot} wsl-autostart   (starts Ubuntu when you sign in to Windows and keeps it running).`,
  );
  if (mode === "none")
    notes.push(`Windows (WSL): Ubuntu runs without systemd, so ${PRODUCT} was started as plain processes. Better: turn systemd on (${ENABLE_SYSTEMD}, then wsl --shutdown in PowerShell) and run  ${dinobot} setup  again.`);
  if (tailscale?.windows)
    notes.push(`Windows (WSL, mirrored networking): Windows' firewall for WSL may block your phone. If the app cannot connect, run once in PowerShell as administrator:  ${hyperVFirewallCommand(port)}`);
  return notes;
}

/** Problems with where things are (pure): Windows drives are slow and cannot keep secrets private. */
export function windowsDriveProblems(L) {
  const out = [];
  for (const [what, p] of [
    ["install", L.root],
    ["bots", L.botsRoot],
    ["home", L.home],
  ]) {
    if (isWindowsDrivePath(p)) out.push({ what, path: p });
  }
  return out;
}

/** Dictation (local speech): the bundled sherpa-onnx is CPU-only, so a GPU is never needed or used. */
export function dictationCheck(wsl) {
  if (wsl?.cuda) return { status: "ok", detail: "on the CPU (an NVIDIA GPU is visible through WSL, but the bundled speech engine is CPU-only; nothing to set up)" };
  if (wsl?.gpu) return { status: "ok", detail: "on the CPU (a GPU is visible through WSL; the bundled speech engine does not use it)" };
  return { status: "ok", detail: "on the CPU" };
}

// ------------------------------------------------------------------ keep Ubuntu running
const MARK = `# ${PRODUCT} (${PRODUCT_ID} wsl-autostart)`;

/**
 * .wslconfig with `[general] instanceIdleTimeout=-1` (on) or our change undone (off). Pure. Other
 * settings are kept. A value we replaced is remembered in our comment line and put back on "off".
 */
export function editWslConfig(text, { on }) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const markAt = lines.findIndex((l) => l.startsWith(MARK));
  if (!on) {
    if (markAt < 0) return { text: text ?? "", changed: false };
    const old = /was: (.*)$/.exec(lines[markAt])?.[1];
    const keyAt = lines.findIndex((l, i) => i > markAt && /^\s*instanceIdleTimeout\s*=/.test(l));
    if (keyAt >= 0) {
      if (old !== undefined && old !== "unset") lines[keyAt] = `instanceIdleTimeout=${old}`;
      else lines.splice(keyAt, 1);
    }
    lines.splice(markAt, 1);
    // An empty [general] we added goes too.
    const g = lines.findIndex((l) => /^\s*\[general\]\s*$/i.test(l));
    if (g >= 0 && (g === lines.length - 1 || /^\s*\[/.test(lines[g + 1]))) lines.splice(g, 1);
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return { text: lines.length ? `${lines.join("\r\n")}\r\n` : "", changed: true };
  }
  if (markAt >= 0) return { text, changed: false };
  let g = lines.findIndex((l) => /^\s*\[general\]\s*$/i.test(l));
  if (g < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("[general]");
    g = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > g && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const keyAt = lines.findIndex((l, i) => i > g && i < end && /^\s*instanceIdleTimeout\s*=/.test(l));
  if (keyAt >= 0) {
    const old = lines[keyAt].split("=").slice(1).join("=").trim();
    if (old === "-1") return { text, changed: false };
    lines.splice(keyAt, 1, `${MARK} keeps Ubuntu running with no window open; was: ${old}`, "instanceIdleTimeout=-1");
  } else {
    lines.splice(g + 1, 0, `${MARK} keeps Ubuntu running with no window open; was: unset`, "instanceIdleTimeout=-1");
  }
  return { text: `${lines.join("\r\n")}\r\n`, changed: true };
}

/** The Startup-folder script that starts the distro (and DinoBot) at Windows sign-in. Pure. */
export function startupScript({ distro, user, dinobot }) {
  const d = distro ? `-d "${distro}" ` : "";
  return [
    "@echo off",
    `rem ${PRODUCT}: starts Ubuntu (WSL) when you sign in to Windows, so your bots stay reachable from your phone.`,
    `rem Made by ${dinobot} wsl-autostart. Remove it with: ${dinobot} wsl-autostart --off`,
    `start "${PRODUCT}" /min wsl.exe ${d}-u ${user} --exec ${dinobot} start`,
    "",
  ].join("\r\n");
}

export function startupScriptPath(winHome, distro) {
  return join(winHome, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${PRODUCT} (WSL${distro ? ` ${distro}` : ""}).cmd`);
}

/** The Windows user's profile folder as a WSL path (/mnt/c/Users/<name>). */
export async function windowsHome({ env = process.env, exec = run } = {}) {
  if (env.DINOBOT_WSL_WINHOME) return env.DINOBOT_WSL_WINHOME;
  const cmd = existsSync("/mnt/c/Windows/System32/cmd.exe") ? "/mnt/c/Windows/System32/cmd.exe" : "cmd.exe";
  const r = await exec(cmd, ["/d", "/c", "echo %USERPROFILE%"], { timeout: 8000, cwd: existsSync("/mnt/c") ? "/mnt/c" : undefined });
  const win = r.stdout.trim().replace(/\r/g, "");
  if (r.code !== 0 || !/^[A-Za-z]:\\/.test(win)) return null;
  const w = await exec("wslpath", ["-u", win], { timeout: 3000 });
  return w.code === 0 && w.stdout.trim() ? w.stdout.trim() : `/mnt/${win[0].toLowerCase()}/${win.slice(3).replace(/\\/g, "/")}`;
}

/** `dinobot wsl-autostart [--off]`: the Startup script plus .wslconfig's instanceIdleTimeout. */
export async function wslAutostart(L, { off = false, env = process.env, exec = run, say = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const winHome = await windowsHome({ env, exec });
  if (!winHome) throw new Error("could not find your Windows user folder (is Windows interop off?). See docs/windows.md for the manual steps.");
  const distro = env.WSL_DISTRO_NAME || null;
  const script = startupScriptPath(winHome, distro);
  const cfgPath = join(winHome, ".wslconfig");
  let before = null;
  try {
    before = readFileSync(cfgPath, "utf8");
  } catch {}
  const cfg = editWslConfig(before ?? "", { on: !off });
  if (off) {
    try {
      unlinkSync(script);
      say(`Removed ${script}`);
    } catch {}
    if (cfg.changed) {
      // Nothing else in it: it was ours alone, so it goes (no empty file left behind).
      if (cfg.text.trim()) writeFileAtomic(cfgPath, cfg.text, 0o644);
      else unlinkSync(cfgPath);
      say(`Undid ${PRODUCT}'s change in ${cfgPath}`);
    }
    say(`Ubuntu no longer starts at sign-in for ${PRODUCT}.`);
    return { script: null, wslconfig: cfgPath };
  }
  mkdirSync(dirname(script), { recursive: true });
  writeFileAtomic(script, startupScript({ distro, user: env.USER || os.userInfo().username, dinobot: join(L.bin, PRODUCT_ID) }), 0o644);
  say(`Wrote ${script} (starts Ubuntu and ${PRODUCT} when you sign in to Windows).`);
  if (cfg.changed) {
    if (before !== null) writeFileAtomic(`${cfgPath}.${PRODUCT_ID}-backup`, before, 0o644);
    writeFileAtomic(cfgPath, cfg.text, 0o644);
    say(`Set instanceIdleTimeout=-1 in ${cfgPath} (Ubuntu keeps running with no window open)${before !== null ? `; the old file is in ${cfgPath}.${PRODUCT_ID}-backup` : ""}.`);
  } else say(`${cfgPath} already keeps Ubuntu running.`);
  say("It takes effect the next time WSL starts: sign out of Windows and back in (or run  wsl --shutdown  in PowerShell, then open Ubuntu).");
  return { script, wslconfig: cfgPath };
}
