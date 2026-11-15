// The installer's terminal layout (lib/tui.mjs) at every window size we design for, from macOS
// Terminal's default 80×24 to a maximised 240×70 on a big monitor (and 60×20, which must degrade
// cleanly). node --test test/tui.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderModules } from "../lib/qr.mjs";
import { codeLines, columnWidth, fitLine, MAX_COLUMN, notesBlock, pairScreen, para, qrBox, StatusLine, stepHeader, stripAnsi, styles, tildify, tuiMode, visible, wrap } from "../lib/tui.mjs";

export const SIZES = { "mac-default": [80, 24], "small-linux": [100, 30], medium: [120, 40], large: [160, 50], huge: [240, 70], "too-narrow": [60, 20] };
// A code as big as ours: 65..73 modules (our links are about 300-360 characters).
const fakeQr = (n) => renderModules(n, (r, c) => (r * 7 + c * 13) % 3 === 0).lines;
const QRS = [fakeQr(69), fakeQr(61)]; // M, then L
const BIG = [fakeQr(73), fakeQr(65)];
const NOTES = [
  "`dinobot` is linked in ~/.local/bin, which is not on your PATH yet. To type just `dinobot`, run this one line (DinoBot does not edit your shell files), then open a new terminal:\n    echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc\n  Until then: ~/.dinobot/bin/dinobot",
  "Started without a service manager (no systemd), so nothing starts it again after a reboot: then run `dinobot start`.",
];
const TS = "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --operator=$USER";

describe("modes", () => {
  it("rich only at a real terminal that is not TERM=dumb; NO_COLOR keeps the layout, drops colour", () => {
    assert.deepEqual(tuiMode({ isTTY: true }, { TERM: "xterm-256color" }), { rich: true, color: true });
    assert.deepEqual(tuiMode({ isTTY: true }, { TERM: "xterm", NO_COLOR: "1" }), { rich: true, color: false });
    assert.deepEqual(tuiMode({ isTTY: true }, { TERM: "dumb" }), { rich: false, color: false });
    assert.deepEqual(tuiMode({ isTTY: false }, { TERM: "xterm" }), { rich: false, color: false });
    assert.equal(styles(false).bold("x"), "x");
    assert.notEqual(styles(true).bold("x"), "x");
  });
});

describe("text never wraps mid-word and stays a readable column", () => {
  for (const [name, [cols]] of Object.entries(SIZES)) {
    it(`${name} ${cols} columns`, () => {
      const text = "Open the DinoBot app on your phone and scan this code. It holds this computer's password: don't share a photo of it. https://login.tailscale.com/admin/machines";
      const lines = para(text, cols);
      for (const l of lines) assert.ok(visible(l) <= Math.min(cols, MAX_COLUMN + 2), `${visible(l)} > ${cols}: ${l}`);
      // every word whole, the URL included
      assert.equal(lines.map((l) => l.trim()).join(" "), text);
      assert.ok(columnWidth(cols) <= MAX_COLUMN);
      for (const l of codeLines(TS, cols)) assert.ok(visible(l) <= cols, `${l} (${cols})`);
      for (const l of notesBlock(NOTES, cols)) assert.ok(visible(l) <= cols, `${visible(l)} > ${cols}: ${l}`);
      assert.ok(visible(stepHeader(2, 3, "Set up this computer", styles(true))[1]) <= cols);
    });
  }
  it("a word longer than the line gets its own line, whole", () => {
    const url = `https://example.com/${"x".repeat(90)}`;
    assert.deepEqual(wrap(`see ${url} now`, 40), ["see", url, "now"]);
  });
  it("the Tailscale one-liner splits at && with a continuation, so it still pastes as one", () => {
    assert.deepEqual(codeLines(TS, 80).map((l) => l.trim()), ["curl -fsSL https://tailscale.com/install.sh | sh && \\", "sudo tailscale up --operator=$USER"]);
    assert.equal(codeLines(TS, 120).length, 1);
  });
  it("~ for the home folder", () => {
    assert.equal(tildify("/home/sam/.dinobot/pairing-qr.png and /home/sam", "/home/sam"), "~/.dinobot/pairing-qr.png and ~");
    assert.equal(tildify("/home/samander/x", "/home/sam"), "/home/samander/x");
  });
});

describe("step 3: the pairing code at every size", () => {
  for (const [name, [cols, rows]] of Object.entries(SIZES)) {
    for (const [what, qrs] of [["typical code", QRS], ["big code", BIG]]) {
      for (const notes of [[], NOTES]) {
        it(`${name} ${cols}×${rows}, ${what}${notes.length ? ", with notes" : ""}: fits, and the whole code or none`, () => {
          for (const opened of [null, "Preview"]) {
            const s = pairScreen({ qrs, cols, rows, product: "DinoBot", picture: "~/.dinobot/pairing-qr.png", opened, desktop: "~/.dinobot/bin/dinobot pair --link", notes, st: styles(true) });
            for (const l of s.lines) assert.ok(visible(l) <= cols, `${s.layout}: ${visible(l)} > ${cols}`);
            if (s.layout !== "fallback") {
              assert.ok(s.lines.length + 2 <= rows, `${s.layout}: ${s.lines.length} rows + status > ${rows}`);
              // the instruction is on screen with the code
              assert.ok(s.lines.some((l) => /Open the DinoBot app/.test(l)));
            } else {
              assert.equal(s.qr, null);
              assert.ok(!s.lines.some((l) => /\u001b\[48;5;(16|231)m/.test(l)), "no partial code");
              assert.ok(s.lines.some((l) => (opened ? /open in Preview/ : /too small/).test(l)), s.lines.join("\n"));
              if (!opened) assert.ok(s.lines.some((l) => l.trim() === "~/.dinobot/pairing-qr.png"), "picture path whole, on its own line");
              const screen = s.lines.slice(0, rows - 2).map((l) => stripAnsi(l).trim()).join(" ");
              assert.match(screen, /scan the pairing code/, "the action is in the first screenful");
            }
          }
        });
      }
    }
  }
  it("80×24 cannot hold a code of our size (a 24-row window holds 48 module rows; ours need 69+): fallback", () => {
    assert.equal(pairScreen({ qrs: QRS, cols: 80, rows: 24, product: "DinoBot" }).layout, "fallback");
  });
  it("big screens show the code with the instruction beside it, and the text stays narrow", () => {
    for (const [cols, rows] of [[160, 50], [240, 70]]) {
      const s = pairScreen({ qrs: QRS, cols, rows, product: "DinoBot", picture: "p.png", notes: NOTES });
      assert.equal(s.layout, "side");
      for (const l of s.lines) assert.ok(visible(l) <= qrBox(QRS[0]).cols + 2 + 60, `no stretching across a wide screen: ${visible(l)} ${JSON.stringify(l.slice(-80))}`);
    }
  });
  it("120×40: the L-level code when only that one fits", () => {
    const s = pairScreen({ qrs: QRS, cols: 120, rows: 40, product: "DinoBot" });
    assert.notEqual(s.layout, "fallback");
  });
});

describe("status line", () => {
  it("redraws in place, cut to the window: a narrower window never stacks copies", () => {
    let out = "";
    let cols = 120;
    const sl = new StatusLine({ out: { write: (s) => (out += s) }, tickMs: 0, size: () => ({ cols, rows: 24 }) });
    sl.set("Downloading  ━━━━━━━━━━━━━━━━━━━━  100%  127/127 MB, and some more words to make it long enough");
    cols = 40;
    sl.set("Downloading  ━━━━━━━━━━━━━━━━━━━━  100%  127/127 MB, and some more words to make it long enough");
    for (const part of out.split("\r")) assert.ok(visible(part.replace(/\u001b\[K/g, "")) <= 120);
    assert.ok(visible(out.split("\r").pop().replace(/\u001b\[K/, "")) <= 39);
    sl.done("Downloaded (127 MB)");
    assert.match(out, /\r\u001b\[K {2}✓ Downloaded \(127 MB\)\n$/);
    sl.stop();
    assert.equal(fitLine("abcdef", 4).length <= 10, true);
  });
});

describe("the small commands (update, uninstall, doctor): plain when piped, rich at a terminal", () => {
  const capture = (isTTY, columns) => {
    const o = { isTTY, columns, text: "", write: (s) => (o.text += s) };
    return o;
  };
  it("piped: exactly the given line (parseable, as before)", async () => {
    const { makeSay } = await import("../lib/tui.mjs");
    const o = capture(false, 0);
    makeSay(o, { TERM: "xterm", HOME: "/home/sam" })("Updated DinoBot 0.1.10 -> 0.1.11 in 9.0s. The previous version is kept in /home/sam/.dinobot/app.old.", "ok");
    assert.equal(o.text, "Updated DinoBot 0.1.10 -> 0.1.11 in 9.0s. The previous version is kept in /home/sam/.dinobot/app.old.\n");
  });
  for (const [name, [cols]] of Object.entries(SIZES)) {
    it(`${name}: wrapped to the window, ~ for home, NO_COLOR without colour codes`, async () => {
      const { makeSay } = await import("../lib/tui.mjs");
      const o = capture(true, cols);
      const say = makeSay(o, { TERM: "xterm", HOME: "/home/sam", NO_COLOR: "1" });
      say("Updated DinoBot 0.1.10 -> 0.1.11 in 9.0s. Your phone stays paired; nothing to do there.", "ok");
      say(NOTES[0]);
      say("The previous version is kept in /home/sam/.dinobot/app.old until the next update.", "dim");
      assert.doesNotMatch(o.text, /\u001b\[/);
      assert.doesNotMatch(o.text, /\/home\/sam/);
      for (const l of o.text.split("\n")) assert.ok(visible(l) <= cols, `${visible(l)} > ${cols}: ${l}`);
    });
    it(`${name}: doctor's table fits`, async () => {
      const { formatChecksRich } = await import("../lib/doctor.mjs");
      const checks = [
        { status: "ok", name: "install", detail: "/home/sam/.dinobot/app" },
        { status: "WARN", name: "reach sams-laptop.tail0000.ts.net:6767", detail: "not checkable from this computer (userspace Tailscale)", fix: "open the DinoBot app on your phone, or: tailscale nc sams-laptop.tail0000.ts.net 6767" },
        { status: "FAIL", name: "daemon ready", detail: "no answer on 127.0.0.1:6767 within 1.5 s", fix: "dinobot doctor --json for details; journalctl --user -u dinobot" },
      ];
      const text = formatChecksRich({ ok: false, checks }, { cols, color: true, home: "/home/sam" });
      for (const l of text.split("\n")) assert.ok(visible(l) <= cols, `${visible(l)} > ${cols}: ${l}`);
      assert.match(stripAnsi(text), /~\/\.dinobot\/app/);
    });
  }
});

describe("fallback screen fits macOS Terminal's 80×24 with notes", () => {
  it("the whole fallback (step, action, picture path, notes) is on one screen", () => {
    for (const [cols, rows] of [[80, 24], [100, 30]]) {
      const s = pairScreen({ qrs: QRS, cols, rows, product: "DinoBot", picture: "~/.dinobot/pairing-qr.png", desktop: "~/.dinobot/bin/dinobot pair --link", notes: NOTES.slice(0, 1), st: styles(false) });
      assert.equal(s.layout, "fallback");
      assert.ok(s.lines.length + 2 <= rows, `${s.lines.length} lines at ${cols}×${rows}`);
    }
  });
});
