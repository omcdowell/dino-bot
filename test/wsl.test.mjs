// windows-wsl: DinoBot inside WSL 2 (Ubuntu) on Windows. node --test test/wsl.test.mjs
// (temp dirs under ./.test-tmp-wsl, never /tmp). Real Windows is not needed: WSL is detected from
// /proc/version + WSL_DISTRO_NAME, and every Windows-side file is a plain file in a temp folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { detectTailscale, tailscaleUsable } from "../lib/detect.mjs";
import { wslChecks } from "../lib/doctor.mjs";
import { serviceMode, systemdUserEnv } from "../lib/service.mjs";
import { tailscaleSteps } from "../lib/tailscale.mjs";
import { layout, PRODUCT, PRODUCT_ID } from "../lib/util.mjs";
import {
  detectWsl,
  dictationCheck,
  editWslConfig,
  ENABLE_SYSTEMD,
  hyperVFirewallCommand,
  isWindowsDrivePath,
  startupScript,
  startupScriptPath,
  windowsDriveProblems,
  wslAutostart,
  wslSetupNotes,
  wslTailscaleSteps,
  wslVersion,
} from "../lib/wsl.mjs";

const TMP = join(import.meta.dirname, "..", ".test-tmp-wsl");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

const WSL2_KERNEL = "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@439a258ad544) (gcc (GCC) 11.2.0) #1 SMP PREEMPT_DYNAMIC";
const WSL1_KERNEL = "Linux version 4.4.0-26100-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0 (GCC) ) #5794-Microsoft";
const PLAIN_KERNEL = "Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075) (x86_64-linux-gnu-gcc-13)";
const ok = (stdout) => async () => ({ code: 0, stdout, stderr: "" });
const missing = async () => ({ code: 127, stdout: "", stderr: "", error: { code: "ENOENT" } });

describe("WSL detection", () => {
  it("WSL 2 and WSL 1 kernels, a plain Linux, and a custom WSL kernel (WSL_DISTRO_NAME only)", () => {
    assert.equal(wslVersion(WSL2_KERNEL, {}), 2);
    assert.equal(wslVersion(WSL1_KERNEL, {}), 1);
    assert.equal(wslVersion(PLAIN_KERNEL, {}), 0);
    assert.equal(wslVersion("Linux version 6.9.0-custom", { WSL_DISTRO_NAME: "Ubuntu-24.04" }), 2);
  });
  it("not WSL: null (plain Linux keeps its behaviour)", async () => {
    assert.equal(await detectWsl({ env: {}, read: () => PLAIN_KERNEL, exec: missing }), null);
  });
  it("WSL 2 with systemd, user bus, mirrored networking (wslinfo), Windows Tailscale and an NVIDIA GPU", async () => {
    const files = new Set(["/run/systemd/system", "/run/user/1000/bus", "/proc/sys/fs/binfmt_misc/WSLInterop", "/mnt/c/Program Files/Tailscale/tailscale.exe", "/dev/dxg", "/usr/lib/wsl/lib/libcuda.so.1"]);
    const w = await detectWsl({ env: { WSL_DISTRO_NAME: "Ubuntu-24.04" }, read: () => WSL2_KERNEL, exists: (p) => files.has(p), exec: ok("mirrored\n"), uid: 1000 });
    assert.deepEqual(w, { version: 2, distro: "Ubuntu-24.04", systemd: true, userBus: true, networking: "mirrored", interop: true, windowsTailscale: true, gpu: true, cuda: true });
  });
  it("WSL 2 without systemd, NAT; old WSL without wslinfo: loopback0 means mirrored, else unknown", async () => {
    const w = await detectWsl({ env: {}, read: () => WSL2_KERNEL, exists: () => false, exec: missing, nets: { eth0: [] } });
    assert.equal(w.systemd, false);
    assert.equal(w.userBus, false);
    assert.equal(w.networking, "unknown");
    assert.equal(w.gpu, false);
    const m = await detectWsl({ env: {}, read: () => WSL2_KERNEL, exists: () => false, exec: missing, nets: { loopback0: [] } });
    assert.equal(m.networking, "mirrored");
    const n = await detectWsl({ env: {}, read: () => WSL2_KERNEL, exists: () => false, exec: ok("nat\n") });
    assert.equal(n.networking, "nat");
  });
  it("Windows drives: /mnt/<letter> only", () => {
    assert.equal(isWindowsDrivePath("/mnt/c"), true);
    assert.equal(isWindowsDrivePath("/mnt/c/Users/sam/.dinobot"), true);
    assert.equal(isWindowsDrivePath("/mnt/data/x"), false);
    assert.equal(isWindowsDrivePath("/home/sam/.dinobot"), false);
    const L = layout({ HOME: "/home/sam", PASEO_BOTS_ROOT: "/mnt/d/bots" });
    assert.deepEqual(windowsDriveProblems(L), [{ what: "bots", path: "/mnt/d/bots" }]);
    assert.deepEqual(windowsDriveProblems(layout({ HOME: "/home/sam" })), []);
  });
});

describe("WSL services: systemd when it really works, else plain processes", () => {
  it("systemd with a user bus: systemd; systemd without one (no dbus-user-session): none; no systemd: none", () => {
    assert.equal(serviceMode({ os: "linux", hasSystemd: true, wsl: { userBus: true } }), "systemd");
    assert.equal(serviceMode({ os: "linux", hasSystemd: true, wsl: { userBus: false } }), "none");
    assert.equal(serviceMode({ os: "linux", hasSystemd: false, wsl: { userBus: false } }), "none");
    assert.equal(serviceMode({ os: "linux", hasSystemd: true }), "systemd", "plain Linux unchanged");
    assert.equal(serviceMode({ os: "linux", hasSystemd: true, wsl: { userBus: false } }, "systemd"), "systemd", "--service wins");
  });
  it("`systemctl --user` started from Windows (no login session) gets XDG_RUNTIME_DIR and the bus", () => {
    const env = systemdUserEnv({ PATH: "/usr/bin" }, 1000, (p) => p === "/run/user/1000" || p === "/run/user/1000/bus");
    assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
    const kept = systemdUserEnv({ XDG_RUNTIME_DIR: "/x", DBUS_SESSION_BUS_ADDRESS: "y" }, 1000, () => true);
    assert.equal(kept.XDG_RUNTIME_DIR, "/x");
    assert.equal(kept.DBUS_SESSION_BUS_ADDRESS, "y");
    assert.equal(systemdUserEnv({}, 1000, () => false).XDG_RUNTIME_DIR, undefined);
  });
});

describe("WSL networking: Tailscale inside Ubuntu (recommended) or Windows' with mirrored networking", () => {
  const WSL = { version: 2, distro: "Ubuntu-24.04", systemd: true, userBus: true, networking: "nat" };
  it("nothing installed: install Tailscale inside Ubuntu (Linux line), then the iPhone, then the finish command", () => {
    const lines = tailscaleSteps({ installed: false, state: "NotInstalled" }, { wsl: WSL, rerun: "R" });
    const text = lines.join("\n");
    assert.match(text, /^1\. Install Tailscale inside Ubuntu.*tailscale\.com\/install\.sh/m);
    assert.match(text, /^2\. Turn it on: +sudo tailscale up/m);
    assert.match(text, /^3\. On your iPhone/m);
    assert.match(text, /Then finish setup: +R/);
    assert.doesNotMatch(text, /systemd/, "Ubuntu 24.04 on WSL has systemd on");
  });
  it("no systemd: turning it on comes first (tailscaled needs it), with wsl --shutdown", () => {
    const text = tailscaleSteps({ installed: false }, { wsl: { ...WSL, systemd: false } }).join("\n");
    assert.match(text, /^1\. Turn on systemd/m);
    assert.ok(text.includes(ENABLE_SYSTEMD));
    assert.match(text, /wsl --shutdown/);
    assert.match(text, /^2\. Install Tailscale inside Ubuntu/m);
  });
  it("Windows Tailscale on but NAT networking: says why it cannot work and recommends Tailscale inside Ubuntu", () => {
    const t = { installed: true, running: true, state: "Running", ip: "100.101.102.103", windows: true, local: false };
    assert.equal(tailscaleUsable(t), false);
    const text = wslTailscaleSteps(t, WSL).join("\n");
    assert.match(text, /on in Windows.*NAT/s);
    assert.match(text, /Install Tailscale inside Ubuntu/);
    assert.match(text, /mirrored/);
  });
  it("Windows Tailscale with mirrored networking (its address is inside Ubuntu too): usable", () => {
    assert.equal(tailscaleUsable({ running: true, ip: "100.64.0.9", windows: true, local: true }), true);
    assert.equal(tailscaleUsable({ running: true, ip: "100.64.0.9" }), true, "Linux / macOS unchanged");
    assert.equal(tailscaleUsable({ running: false, ip: "100.64.0.9" }), false);
  });
  it("detectTailscale on WSL asks Windows' tailscale.exe when Ubuntu has none, and checks its address is local", async () => {
    const exe = join(TMP, "tailscale.exe");
    const status = (ip) => JSON.stringify({ BackendState: "Running", Self: { DNSName: "winbox.tail1.ts.net.", TailscaleIPs: [ip, "fd7a::1"] }, CurrentTailnet: { MagicDNSEnabled: true } });
    writeFileSync(exe, `#!/bin/sh\necho '${status("100.64.0.21")}'\n`, { mode: 0o755 });
    // PATH without a Linux tailscale: only the Windows one answers.
    // No Linux tailscale (bins: a path that does not exist): only the Windows one answers.
    const env = { DINOBOT_WINDOWS_TAILSCALE: exe };
    const bins = [join(TMP, "no-tailscale")];
    const nat = await detectTailscale({ env, bins, wsl: WSL, nets: { eth0: [{ address: "172.20.1.5" }] } });
    assert.deepEqual([nat.running, nat.windows, nat.local, nat.ip, nat.dnsName], [true, true, false, "100.64.0.21", "winbox.tail1.ts.net"]);
    const mirrored = await detectTailscale({ env, bins, wsl: { ...WSL, networking: "mirrored" }, nets: { eth1: [{ address: "100.64.0.21" }] } });
    assert.deepEqual([mirrored.windows, mirrored.local], [true, true]);
    const notWsl = await detectTailscale({ env, bins });
    assert.equal(notWsl.installed, false, "the Windows CLI is only tried on WSL");
    assert.equal("windows" in notWsl, false);
  });
  it("Tailscale inside Ubuntu wins over Windows' (DINOBOT_TAILSCALE_BIN is then the only one)", async () => {
    const lin = join(TMP, "tailscale-linux");
    writeFileSync(lin, `#!/bin/sh\necho '${JSON.stringify({ BackendState: "Running", Self: { DNSName: "ubuntu-wsl.tail1.ts.net.", TailscaleIPs: ["100.64.0.22"] } })}'\n`, { mode: 0o755 });
    const t = await detectTailscale({ env: { DINOBOT_TAILSCALE_BIN: lin, DINOBOT_WINDOWS_TAILSCALE: join(TMP, "tailscale.exe") }, wsl: WSL });
    assert.deepEqual([t.ip, t.windows], ["100.64.0.22", false]);
  });
  it("the mirrored-mode firewall rule is scoped: this port, tailnet sources only, never 0.0.0.0", () => {
    const cmd = hyperVFirewallCommand(6770);
    assert.match(cmd, /^New-NetFirewallHyperVRule /);
    assert.match(cmd, /-LocalPorts 6770 /);
    assert.match(cmd, /-RemoteAddresses 100\.64\.0\.0\/10$/);
    assert.match(cmd, /-VMCreatorId '\{40E0AC32-46A5-438A-A0B2-2B479E8F2E90\}'/);
    assert.doesNotMatch(cmd, /0\.0\.0\.0/);
  });
});

describe("WSL setup notes and doctor", () => {
  const L = layout({ HOME: "/home/sam" });
  const WSL = { version: 2, distro: "Ubuntu-24.04", systemd: true, userBus: true, networking: "nat" };
  it("always: keep-running hint with the full wsl-autostart command; none mode: turn systemd on; Windows Tailscale: the firewall rule", () => {
    assert.deepEqual(wslSetupNotes({ wsl: null, mode: "systemd", port: 1, bin: L.bin }), []);
    const sd = wslSetupNotes({ wsl: WSL, mode: "systemd", port: 6767, tailscale: { windows: false }, bin: L.bin });
    assert.equal(sd.length, 1);
    assert.ok(sd[0].includes(`/home/sam/.${PRODUCT_ID}/bin/${PRODUCT_ID} wsl-autostart`), sd[0]);
    const none = wslSetupNotes({ wsl: WSL, mode: "none", port: 6767, tailscale: { windows: true }, bin: L.bin }).join("\n");
    assert.ok(none.includes(ENABLE_SYSTEMD));
    assert.ok(none.includes(hyperVFirewallCommand(6767)));
  });
  it("doctor: WARN until wsl-autostart ran, OK after; systemd off is a WARN; WSL 1 and a Windows-drive install FAIL", () => {
    const winHome = "/mnt/c/Users/Sam";
    const files = {};
    const read = (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    };
    const exists = (p) => p in files;
    const base = { wsl: WSL, mode: "systemd", tailscale: { windows: false }, port: 6767, L, winHome, read, exists };
    const keep = () => Object.fromEntries(wslChecks(base))["keep running (WSL)"];
    assert.equal(keep().status, "WARN");
    assert.match(keep().fix, /wsl-autostart/);
    files[startupScriptPath(winHome, "Ubuntu-24.04")] = "x";
    files[`${winHome}/.wslconfig`] = "[general]\r\ninstanceIdleTimeout=-1\r\n";
    assert.equal(keep().status, "OK".toLowerCase());
    const none = Object.fromEntries(wslChecks({ ...base, mode: "none" }));
    assert.equal(none["systemd (WSL)"].status, "WARN");
    assert.equal(Object.fromEntries(wslChecks({ ...base, wsl: { ...WSL, version: 1 } })).WSL.status, "FAIL");
    const drive = Object.fromEntries(wslChecks({ ...base, L: layout({ HOME: "/home/sam", DINOBOT_HOME: "/mnt/c/db" }) }));
    assert.equal(drive["Windows drive (install)"].status, "FAIL");
    assert.equal(wslChecks({ ...base, wsl: null }).length, 0, "not WSL: no WSL checks");
    const fw = Object.fromEntries(wslChecks({ ...base, tailscale: { windows: true, running: true } }));
    assert.ok(fw["Windows firewall (WSL)"].detail.includes(hyperVFirewallCommand(6767)));
  });
  it("dictation: always the CPU (bundled sherpa-onnx is CPU-only); a WSL GPU is mentioned, never required", () => {
    assert.equal(dictationCheck(null).detail, "on the CPU");
    assert.match(dictationCheck({ gpu: true, cuda: true }).detail, /NVIDIA GPU is visible.*CPU-only/);
    assert.match(dictationCheck({ gpu: true, cuda: false }).detail, /GPU is visible/);
    for (const w of [null, { gpu: true }, { cuda: true }]) assert.equal(dictationCheck(w).status, "ok");
  });
});

describe("keep Ubuntu running: .wslconfig and the Startup script", () => {
  it("no .wslconfig: adds [general] instanceIdleTimeout=-1 (CRLF); off removes it all", () => {
    const on = editWslConfig("", { on: true });
    assert.equal(on.changed, true);
    assert.match(on.text, /^\[general\]\r\n# .*wsl-autostart.*was: unset\r\ninstanceIdleTimeout=-1\r\n$/);
    assert.equal(editWslConfig(on.text, { on: true }).changed, false, "idempotent");
    const off = editWslConfig(on.text, { on: false });
    assert.deepEqual(off, { text: "", changed: true });
  });
  it("keeps the user's other settings; a replaced value comes back on off", () => {
    const mine = "[wsl2]\nmemory=8GB\nnetworkingMode=mirrored\n\n[general]\ninstanceIdleTimeout=60000\n";
    const on = editWslConfig(mine, { on: true });
    assert.match(on.text, /memory=8GB/);
    assert.match(on.text, /networkingMode=mirrored/);
    assert.match(on.text, /was: 60000\r\ninstanceIdleTimeout=-1/);
    assert.doesNotMatch(on.text, /instanceIdleTimeout=60000/);
    const off = editWslConfig(on.text, { on: false });
    assert.equal(off.text, "[wsl2]\r\nmemory=8GB\r\nnetworkingMode=mirrored\r\n\r\n[general]\r\ninstanceIdleTimeout=60000\r\n");
    assert.equal(editWslConfig(mine, { on: false }).changed, false, "nothing of ours: off changes nothing");
    assert.equal(editWslConfig("[general]\ninstanceIdleTimeout=-1\n", { on: true }).changed, false, "already -1");
  });
  it("[general] added after existing sections, key inside it (not in [wsl2])", () => {
    const on = editWslConfig("[wsl2]\nmemory=8GB\n", { on: true }).text.split("\r\n");
    const g = on.indexOf("[general]");
    assert.ok(g > on.indexOf("memory=8GB"));
    assert.equal(on[g + 2], "instanceIdleTimeout=-1");
  });
  it("the Startup script starts this distro as this user and runs dinobot start (CRLF, minimised)", () => {
    const s = startupScript({ distro: "Ubuntu-24.04", user: "sam", dinobot: "/home/sam/.dinobot/bin/dinobot" });
    assert.ok(s.endsWith("\r\n"));
    assert.ok(s.split("\r\n").every((l) => !l.includes("\n")));
    assert.match(s, /^@echo off\r\n/);
    assert.ok(s.includes(`start "${PRODUCT}" /min wsl.exe -d "Ubuntu-24.04" -u sam --exec /home/sam/.dinobot/bin/dinobot start\r\n`), s);
    assert.match(startupScriptPath("/mnt/c/Users/Sam", "Ubuntu-24.04"), /AppData\/Roaming\/Microsoft\/Windows\/Start Menu\/Programs\/Startup\/.* \(WSL Ubuntu-24\.04\)\.cmd$/);
  });
  it("dinobot wsl-autostart writes both (backing up .wslconfig), --off undoes both", async () => {
    const win = join(TMP, "winhome");
    mkdirSync(win, { recursive: true });
    writeFileSync(join(win, ".wslconfig"), "[wsl2]\r\nmemory=4GB\r\n");
    const L = layout({ HOME: join(TMP, "home") });
    const out = [];
    const env = { DINOBOT_WSL_WINHOME: win, WSL_DISTRO_NAME: "Ubuntu-24.04", USER: "sam" };
    const r = await wslAutostart(L, { env, say: (s) => out.push(s) });
    assert.ok(existsSync(r.script));
    assert.match(readFileSync(r.script, "utf8"), /wsl\.exe -d "Ubuntu-24\.04" -u sam --exec /);
    assert.match(readFileSync(join(win, ".wslconfig"), "utf8"), /memory=4GB[\s\S]*\[general\][\s\S]*instanceIdleTimeout=-1/);
    assert.equal(readFileSync(join(win, `.wslconfig.${PRODUCT_ID}-backup`), "utf8"), "[wsl2]\r\nmemory=4GB\r\n");
    assert.match(out.join("\n"), /sign out of Windows and back in/);
    await wslAutostart(L, { env, off: true, say: () => {} });
    assert.equal(existsSync(r.script), false);
    assert.equal(readFileSync(join(win, ".wslconfig"), "utf8"), "[wsl2]\r\nmemory=4GB\r\n");
  });
  it("--off removes a .wslconfig that only held our line (no empty file left)", async () => {
    const win = join(TMP, "winhome-empty");
    mkdirSync(win, { recursive: true });
    const L = layout({ HOME: join(TMP, "home3") });
    const env = { DINOBOT_WSL_WINHOME: win, WSL_DISTRO_NAME: "Ubuntu-24.04", USER: "sam" };
    await wslAutostart(L, { env, say: () => {} });
    assert.ok(existsSync(join(win, ".wslconfig")));
    await wslAutostart(L, { env, off: true, say: () => {} });
    assert.equal(existsSync(join(win, ".wslconfig")), false);
  });
  it("no Windows folder found (interop off): a plain error, nothing written", async () => {
    const L = layout({ HOME: join(TMP, "home2") });
    await assert.rejects(wslAutostart(L, { env: {}, exec: missing, say: () => {} }), /Windows user folder/);
  });
});

// install.sh with faked WSL markers (DINOBOT_PROC_VERSION / WSL_DISTRO_NAME) and a faked Git Bash.
describe("install.sh on Windows / WSL", { skip: process.platform !== "linux" }, () => {
  const sh = join(import.meta.dirname, "..", "install.sh");
  const TOOLS = ["sh", "uname", "tar", "mkdir", "cat", "cut", "tr", "grep", "sed", "date", "awk", "id", "getent", "sha256sum", "head", "ls", "rm", "mv", "cp", "chmod", "sleep", "env", "dirname", "ps"];
  function binDir(name, fakes = {}) {
    const d = join(TMP, name);
    mkdirSync(d, { recursive: true });
    for (const t of TOOLS) {
      if (fakes[t]) continue;
      const real = ["/usr/bin", "/bin"].map((p) => join(p, t)).find(existsSync);
      if (real) symlinkSync(real, join(d, t));
    }
    for (const [t, body] of Object.entries(fakes)) writeFileSync(join(d, t), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return d;
  }
  const kernel = (name, text) => {
    const f = join(TMP, name);
    writeFileSync(f, `${text}\n`);
    return f;
  };
  function run(bin, env) {
    try {
      return { code: 0, out: execFileSync(join(bin, "sh"), [sh, "--yes"], { env: { PATH: bin, DINOBOT_NAME: "T", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  }
  it("Git Bash / MSYS on Windows: points to WSL (wsl --install -d Ubuntu-24.04), nothing written", () => {
    const home = join(TMP, "h-mingw");
    const r = run(binDir("bin-mingw", { uname: `[ "$1" = -m ] && echo x86_64 || echo MINGW64_NT-10.0-26100` }), { HOME: home });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /runs inside WSL/);
    assert.match(r.out, /wsl --install -d Ubuntu-24\.04/);
    assert.equal(existsSync(join(home, `.${PRODUCT_ID}`)), false);
  });
  it("WSL 1: stops with the wsl --set-version line, nothing written", () => {
    const home = join(TMP, "h-wsl1");
    const r = run(binDir("bin-wsl1"), { HOME: home, WSL_DISTRO_NAME: "Ubuntu", DINOBOT_PROC_VERSION: kernel("v1", WSL1_KERNEL) });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /WSL 1/);
    assert.match(r.out, /wsl --set-version Ubuntu 2/);
    assert.equal(existsSync(join(home, `.${PRODUCT_ID}`)), false);
  });
  it("WSL 2 with DINOBOT_HOME on a Windows drive: stops (password could not be private)", () => {
    const r = run(binDir("bin-wsl2d"), { HOME: join(TMP, "h-wsl2d"), DINOBOT_HOME: "/mnt/c/Users/sam/dinobot", DINOBOT_PROC_VERSION: kernel("v2", WSL2_KERNEL) });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /Windows drive/);
  });
  it("WSL 2 (kernel marker, or WSL_DISTRO_NAME alone): says so and carries on to the download", () => {
    for (const [i, env] of [{ DINOBOT_PROC_VERSION: kernel("v2b", WSL2_KERNEL), WSL_DISTRO_NAME: "Ubuntu-24.04" }, { DINOBOT_PROC_VERSION: kernel("vp", PLAIN_KERNEL), WSL_DISTRO_NAME: "Ubuntu-24.04" }].entries()) {
      const r = run(binDir(`bin-wsl2-${i}`), { HOME: join(TMP, `h-wsl2-${i}`), ...env });
      assert.match(r.out, /Windows WSL Ubuntu-24\.04/, r.out);
      assert.match(r.out, /untested/i, "warns that Windows is untested");
      assert.match(r.out, /Downloading/, "got to the download");
    }
  });
  it("plain Linux: no WSL wording", () => {
    const r = run(binDir("bin-plain"), { HOME: join(TMP, "h-plain"), DINOBOT_PROC_VERSION: kernel("vplain", PLAIN_KERNEL) });
    assert.doesNotMatch(r.out, /WSL/);
    assert.doesNotMatch(r.out, /untested/i);
  });
});
