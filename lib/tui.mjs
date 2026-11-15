// The installer's terminal layout (install.sh hands over to `dinobot setup`; update and uninstall use
// it too). Two modes:
//   rich   stdout is a terminal and TERM is not "dumb": step headers, room around the one thing the
//          user must do, one status line redrawn in place, prose in a readable column, detail in a
//          log file. Colour unless NO_COLOR.
//   plain  piped, CI, logs, TERM=dumb: the plain lines as before (parseable; tests read them).
// Everything here that draws is pure (width in, lines out), so every size is unit-tested.

/** Left margin and the widest prose column on any screen (a 240-column terminal stays readable). */
export const MARGIN = 2;
export const MAX_COLUMN = 76;
/** Width/height when the terminal does not say (never 0). */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** { rich, color } for a stream and environment. */
export function tuiMode(stream = process.stdout, env = process.env) {
  const rich = Boolean(stream?.isTTY) && env.TERM !== "dumb";
  return { rich, color: rich && !env.NO_COLOR };
}

export function termSize(stream = process.stdout, env = process.env) {
  const cols = stream?.columns || Number(env.COLUMNS) || DEFAULT_COLS;
  const rows = stream?.rows || Number(env.LINES) || DEFAULT_ROWS;
  return { cols, rows };
}

/** The prose column for a terminal `cols` wide (at least 20). */
export function columnWidth(cols) {
  return Math.max(20, Math.min(cols - 2 * MARGIN, MAX_COLUMN));
}

/** SGR helpers that are no-ops without colour. */
export function styles(color) {
  const w = (open, close) => (s) => (color ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
  return { bold: w(1, 22), dim: w(2, 22), green: w(32, 39), red: w(31, 39), cyan: w(36, 39), yellow: w(33, 39) };
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (s) => String(s).replace(ANSI, "");
/** Display width: ANSI codes take none; everything we print is one column per code point. */
export const visible = (s) => [...stripAnsi(s)].length;

/**
 * Word wrap to `width`, never inside a word: a word longer than the width (a URL, a path, a command
 * piece) gets a line of its own, whole. Keeps explicit newlines. -> lines.
 */
export function wrap(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    const lead = para.match(/^ */)[0];
    const words = para.slice(lead.length).split(/ +/).filter((w) => w !== "");
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = lead;
    for (const w of words) {
      const cur = visible(line);
      if (cur > lead.length && cur + 1 + visible(w) > width) {
        out.push(line);
        line = lead + w;
      } else line = cur > lead.length ? `${line} ${w}` : line + w;
    }
    out.push(line);
  }
  return out;
}

/** Text in the prose column at the margin (plus `indent`), for a terminal `cols` wide. */
export function para(text, cols, { indent = 0, first = "" } = {}) {
  const pad = " ".repeat(MARGIN + indent);
  const width = columnWidth(cols) - indent - visible(first);
  return wrap(text, width).map((l, i) => (i === 0 ? `${pad}${first}${l}` : `${pad}${" ".repeat(visible(first))}${l}`));
}

/** A command, path or URL on its own line(s), never broken inside a token: `a && b` splits with `\`. */
export function codeLines(cmd, cols, { indent = 2, margin = MARGIN } = {}) {
  const parts = visible(cmd) <= cols - margin - indent || !cmd.includes(" && ") ? [cmd] : cmd.split(" && ").map((p, i, a) => `${i ? "  " : ""}${p}${i < a.length - 1 ? " && \\" : ""}`);
  // The indent gives way before the command does (narrow windows): a command is never broken.
  const longest = Math.max(...parts.map(visible));
  const pad = " ".repeat(Math.max(0, Math.min(margin + indent, cols - longest)));
  return parts.map((p) => `${pad}${p}`);
}

/** `/home/sam/.dinobot/x` -> `~/.dinobot/x`. */
export function tildify(text, home) {
  if (!home || home === "/") return String(text);
  return String(text).split(`${home}/`).join("~/").replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s\`'"),])`, "g"), "~");
}

/** "Step 2 of 3 · Set up this computer", with a blank line before. */
export function stepHeader(n, of, title, st) {
  return ["", `${" ".repeat(MARGIN)}${st.cyan(`Step ${n} of ${of}`)}  ${st.bold(title)}`, ""];
}

/** Cut a status line so it never wraps (a wrapped line cannot be redrawn with \r). */
export function fitLine(s, cols) {
  const max = Math.max(10, cols - 1);
  if (visible(s) <= max) return s;
  const plain = [...stripAnsi(s)];
  return `${plain.slice(0, max - 1).join("")}…`;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * One line redrawn in place: set(text) shows "⠋ text" (spinner ticking), done(text) leaves "✓ text",
 * fail(text) "✗ text", info(text) a plain line. Width is read at each draw (resize-safe). Rich only;
 * in plain mode nothing is drawn (callers print their plain lines themselves).
 */
export class StatusLine {
  constructor({ out = process.stdout, st = styles(false), tickMs = 100, size = () => termSize(out) } = {}) {
    this.out = out;
    this.st = st;
    this.size = size;
    this.text = null;
    this.i = 0;
    this.tickMs = tickMs;
    this.timer = null;
    this.onExit = () => {
      if (this.text !== null) this.out.write("\n");
    };
    process.once?.("exit", this.onExit);
  }
  draw() {
    if (this.text === null) return;
    const line = `${" ".repeat(MARGIN)}${this.st.cyan(SPIN[this.i % SPIN.length])} ${this.text}`;
    this.out.write(`\r\u001b[K${fitLine(line, this.size().cols)}`);
  }
  set(text) {
    this.text = text;
    this.draw();
    if (!this.timer && this.tickMs) {
      this.timer = setInterval(() => {
        this.i++;
        this.draw();
      }, this.tickMs);
      this.timer.unref?.();
    }
  }
  clear() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.text !== null) this.out.write("\r\u001b[K");
    this.text = null;
  }
  end(mark, text) {
    this.clear();
    const lines = para(text, this.size().cols, { first: `${mark} ` });
    this.out.write(`${lines.join("\n")}\n`);
  }
  done(text) {
    this.end(this.st.green("✓"), text);
  }
  fail(text) {
    this.end(this.st.red("✗"), text);
  }
  stop() {
    this.clear();
    process.removeListener?.("exit", this.onExit);
  }
}

// ------------------------------------------------------------------ step 3: the pairing code

/** Rows/columns a QR's terminal lines take. */
export function qrBox(lines) {
  return { rows: lines.length, cols: lines.length ? visible(lines[0]) : 0 };
}

const SIDE_MIN = 34; // narrowest instruction column beside the code
const SIDE_MAX = 56;

/**
 * The step-3 screen for a window `cols` × `rows`: the pairing code with the one instruction next to
 * it ("side", when there is room), under it ("stack"), or, when the window cannot show the whole
 * code, no code at all ("fallback": says so, points at the picture; the caller redraws on resize).
 * `qrs`: the code's terminal lines, best first (error correction M, then L: fewer modules).
 * `notes`: "Good to know" lines for the end (side column or below). `reserve`: rows kept free
 * under it (the status line). -> { lines, layout, qr }.
 */
export function pairScreen(opts) {
  // The code first: with the notes if they fit, else the code alone (notesShown false: the caller
  // points at where they are); a window too small for any code gets the fallback, notes included.
  const withNotes = pairScreenWith(opts);
  if (withNotes.layout !== "fallback" || !opts.notes?.length) return { ...withNotes, notesShown: true };
  const without = pairScreenWith({ ...opts, notes: [] });
  return without.layout !== "fallback" ? { ...without, notesShown: false } : { ...withNotes, notesShown: true };
}

function pairScreenWith({ qrs, cols, rows, product, step = [3, 3], picture = null, opened = null, desktop = null, note = null, notes = [], reserve = 2, live = true, again = null, st = styles(false) }) {
  const header = stepHeader(step[0], step[1], "Connect your phone", st).slice(1); // screen top: no blank first
  const action = `Open the ${product} app on your phone and scan this code.`;
  // What the code holds (offer.mjs pairingCodeNote: the password, or a one-use ticket; QR2).
  const secret = note ?? "It holds this computer's password: don't share a photo of it.";
  const fits = (lines) => lines.length + reserve <= rows && lines.every((l) => visible(l) <= cols);
  for (const qr of qrs) {
    const box = qrBox(qr);
    // side: text column right of the code
    const w = Math.min(cols - box.cols - 2 - 1, SIDE_MAX);
    if (w >= SIDE_MIN) {
      const text = [];
      for (const l of wrap(action, w)) text.push(st.bold(l));
      text.push("");
      for (const l of wrap(secret, w)) text.push(st.dim(l));
      if (picture) text.push("", ...wrap(opened ? `Can't scan it? The picture is open in ${opened}:` : "Can't scan it? There is a picture of it:", w).map(st.dim), st.dim(picture));
      if (desktop) text.push("", ...wrap(`On a computer? In the desktop app, "Paste pairing link" with what this prints:`, w).map(st.dim), st.dim(desktop));
      const room = Math.min(cols - box.cols - 3, w + 4); // a little more than the column right of the code (commands may use it)
      const noteText = notesBlock(notes, room, st, { margin: 0, width: w });
      const all = noteText.length && text.length + noteText.length <= box.rows && noteText.every((l) => visible(l) <= room) ? [...text, ...noteText] : text;
      const top = Math.max(0, Math.min(2, box.rows - all.length));
      const lines = [...header];
      for (let i = 0; i < Math.max(box.rows, top + all.length); i++) lines.push(`${qr[i] ?? " ".repeat(box.cols)}  ${all[i - top] ?? ""}`.replace(/ +$/, ""));
      if (all !== text) {
        if (fits(lines)) return { lines, layout: "side", qr };
      } else {
        const withNotes = [...lines, ...notesBlock(notes, cols, st)];
        if (fits(withNotes)) return { lines: withNotes, layout: "side", qr };
      }
    }
    // stack: text under the code
    const lines = [...header, ...qr, ""];
    lines.push(...para(action, cols).map((l) => st.bold(l)));
    lines.push(...para(secret, cols).map((l) => st.dim(l)));
    if (picture) lines.push(...para(`Can't scan it? ${opened ? `The picture is open in ${opened}.` : `Picture: ${picture}`}`, cols).map((l) => st.dim(l)));
    if (desktop) lines.push(...para(`Desktop app: "Paste pairing link" with: ${desktop}`, cols).map((l) => st.dim(l)));
    lines.push(...notesBlock(notes, cols, st));
    if (fits(lines)) return { lines, layout: "stack", qr };
  }
  // Fallback: no partial code on screen (a phone may try to read half a code). Shortened (no
  // desktop line, fewer blank lines) until it fits the window, so the step and the action stay on it.
  const need = qrs.map(qrBox).reduce((a, b) => (b.rows < a.rows ? b : a));
  const size = `at least ${need.cols} wide and ${need.rows + 2 + reserve} tall, or full screen`;
  const build = (tier) => {
    const gap = tier < 2 ? [""] : [];
    const lines = [...header];
    lines.push(...para(`Open the ${product} app on your phone and scan the pairing code.`, cols).map((l) => st.bold(l)), "");
    if (opened) {
      lines.push(...para(`The code is open in ${opened}: scan it from there.`, cols));
      lines.push(...para(`(This window is too small to show it here too: ${size}.)`, cols).map((l) => st.dim(l)));
    } else {
      lines.push(...para(live ? `This window is too small to show the code. Make it bigger (${size}) and the code appears here.` : `This window is too small to show the code. Make it bigger (${size}), then run:`, cols));
      if (!live && again) lines.push(...codeLines(again, cols));
      if (picture) lines.push(...gap, ...para("Or open the picture of it:", cols), ...codeLines(picture, cols));
    }
    lines.push(...gap, ...para(secret, cols).map((l) => st.dim(l)));
    if (desktop && tier < 1) lines.push(...para(`On a computer? In the desktop app, "Paste pairing link" with what this prints:`, cols).map((l) => st.dim(l)), ...codeLines(desktop, cols).map((l) => st.dim(l)));
    const nb = notesBlock(notes, cols, st);
    lines.push(...(tier < 2 ? nb : nb.slice(1)));
    return lines;
  };
  let lines = build(0);
  for (let tier = 1; tier <= 2 && lines.length + reserve > rows; tier++) lines = build(tier);
  return { lines, layout: "fallback", qr: null };
}

/** "Good to know" block for notes that need the user (wrapped; commands on their own lines). */
export function notesBlock(notes, cols, st = styles(false), { margin = MARGIN, width = columnWidth(cols) } = {}) {
  if (!notes.length) return [];
  const m = " ".repeat(margin);
  const lines = ["", `${m}${st.bold("Good to know")}`];
  for (const n of notes) {
    for (const [i, part] of String(n).split("\n").entries()) {
      const t = part.trim();
      if (!t) continue;
      // An indented line of a note is a command to copy: its own line, whole.
      if (i > 0 && /^ {3,}/.test(part)) {
        lines.push(...codeLines(t, margin + width + (cols > margin + width ? Math.min(cols - margin - width, MARGIN) : 0), { margin, indent: 4 }));
      } else {
        const ind = i > 0 ? 4 : 2;
        wrap(t, width - ind).forEach((l, j) => lines.push(`${m}${j === 0 && i === 0 ? "• " : " ".repeat(ind)}${l}`));
      }
    }
  }
  return lines;
}

/** Clear the screen in place (a redraw after a resize). */
export const CLEAR = "\u001b[H\u001b[2J";
/** A fresh screen that keeps what was on it in the scrollback (in every terminal): scroll it up, then home. */
export const freshScreen = (rows) => `${"\n".repeat(Math.max(1, rows))}\u001b[H\u001b[J`;

/**
 * A `say` for the small commands (update, uninstall, post-update). Plain mode: the line as given.
 * Rich mode: wrapped in the readable column at the margin, home shown as ~, a line indented 3+
 * spaces kept whole (a command to copy), and an optional look: ok (✓, bold), fail (✗), dim, bold,
 * head (bold, with a blank line before). -> say(text, look?)
 */
export function makeSay(out = process.stdout, env = process.env) {
  const mode = tuiMode(out, env);
  const st = styles(mode.color);
  return (text = "", look = null) => {
    if (!mode.rich) return out.write(`${text}\n`);
    const { cols } = termSize(out, env);
    const t = tildify(text, env.HOME);
    const lines = [];
    for (const [i, part] of t.split("\n").entries()) {
      if (!part.trim()) lines.push("");
      else if (/^ {3,}\S/.test(part)) lines.push(...codeLines(part.trim(), cols, { indent: 2 + (i ? 2 : 0) }));
      else {
        const lead = part.match(/^ */)[0].length;
        const first = i === 0 && look === "ok" ? `${st.green("✓")} ` : i === 0 && look === "fail" ? `${st.red("✗")} ` : "";
        const body = para(part.trim(), cols, { indent: lead + (i && first === "" && look && /ok|fail/.test(look) ? 2 : 0), first });
        lines.push(...body.map((l) => (look === "dim" ? st.dim(l) : look === "bold" || look === "head" || look === "ok" ? st.bold(l) : l)));
      }
    }
    if (look === "head") lines.unshift("");
    out.write(`${lines.join("\n")}\n`);
  };
}

/** The rich download line: "  Downloading  ━━━━━━──────  45%  57/127 MB", cut to the window. */
export function progressBar(got, total, cols, color = true) {
  const st = styles(color);
  const mb = (n) => Math.floor(n / 1048576);
  if (!total) return fitLine(`${" ".repeat(MARGIN)}Downloading  ${mb(got)} MB`, cols);
  const pc = Math.min(100, Math.floor((got * 100) / total));
  const w = Math.max(0, Math.min(20, cols - 36));
  const h = Math.floor((pc * w) / 100);
  const bar = w >= 5 ? `${st.cyan("━".repeat(h) + "─".repeat(w - h))}  ` : "";
  return fitLine(`${" ".repeat(MARGIN)}Downloading  ${bar}${String(pc).padStart(3)}%  ${mb(got)}/${mb(total)} MB`, cols);
}
