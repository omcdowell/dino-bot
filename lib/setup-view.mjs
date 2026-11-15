// What `dinobot setup` draws at a real terminal (rich mode, lib/tui.mjs): step headers, one status
// line, the step-3 screen (pairing code + the one instruction) redrawn when the window is resized,
// then "sign in on your phone" and "ready". Plain mode (pipes, CI, TERM=dumb) does not use this:
// cli.mjs prints its plain lines as before.
import { CLEAR, freshScreen, notesBlock, pairScreen, para, codeLines, StatusLine, stepHeader, styles, termSize, tildify } from "./tui.mjs";

export class SetupView {
  /**
   * steps: 3 after install.sh (1 = its download), 2 for a `dinobot setup` run by hand.
   * out: the terminal stream (columns/rows read at each draw; "resize" redraws step 3).
   */
  constructor({ out = process.stdout, home = "", product, steps = 3, color = true, size = () => termSize(out) } = {}) {
    this.out = out;
    this.home = home;
    this.product = product;
    this.steps = steps;
    this.st = styles(color);
    this.size = size;
    this.status = new StatusLine({ out, st: this.st, size });
    this.screen = null; // step 3, for a redraw on resize
    this.onResize = () => this.repaint();
  }
  write(lines) {
    if (lines.length) this.out.write(`${lines.join("\n")}\n`);
  }
  t(s) {
    return tildify(s, this.home);
  }
  /** Step header; n counts from the end (the last step is "Connect your phone"). */
  header(fromEnd, title) {
    this.status.clear();
    this.write(stepHeader(this.steps - fromEnd, this.steps, title, this.st));
  }
  say(text, { dim = false, indent = 0 } = {}) {
    this.status.clear();
    this.write(para(this.t(text), this.size().cols, { indent }).map((l) => (dim ? this.st.dim(l) : l)));
  }
  busy(text) {
    this.status.set(text);
  }
  done(text) {
    this.status.done(this.t(text));
  }
  /**
   * Numbered steps as tailscale.mjs / wsl.mjs write them ("1. Do this:   <command>   (comment)",
   * an indented line = a command): prose wrapped with a hanging indent, each command on its own
   * line, whole, comments dimmed under it.
   */
  stepsBlock(lines) {
    this.status.clear();
    this.write(formatSteps(lines.map((l) => this.t(l)), this.size().cols, this.st));
  }
  /** Step 3: a fresh screen with the code (or the fallback). Watches resizes until closed. */
  pair({ qrs, picture, opened, desktop, note = null, notes = [], waiting = null, end = null, log = null, again = null }) {
    this.screen = { log, again: again && this.t(again), qrs, note: note && this.t(note), picture: picture && this.t(picture), opened, desktop: desktop && this.t(desktop), notes: notes.map((n) => this.t(n)), waiting, end: end && this.t(end) };
    if (!this.listening) {
      this.out.on?.("resize", this.onResize);
      this.listening = true;
    }
    this.repaint();
  }
  repaint() {
    if (!this.screen) return;
    const { cols, rows } = this.size();
    const s = this.screen;
    this.status.clear();
    const p = pairScreen({ qrs: s.qrs, cols, rows, product: this.product, step: [this.steps, this.steps], picture: s.picture, opened: s.opened, desktop: s.desktop, note: s.note, notes: s.notes, reserve: s.end ? 4 : 2, live: !s.end, again: s.again, st: this.st });
    this.out.write(this.drawn ? CLEAR : freshScreen(rows));
    this.drawn = true;
    this.write(p.lines);
    this.layout = p.layout;
    if (s.end) {
      // The fallback already says how to get the code again.
      const end = p.layout === "fallback" ? s.end.replace(/ Show the code again: .*$/, "") : s.end;
      const more = s.notes.length && !p.notesShown ? ` ${s.notes.length === 1 ? "A note" : `${s.notes.length} notes`} for later: ${this.t(s.log ?? "")}` : "";
      this.write(["", ...para(`${end}${more}`, cols, { first: `${this.st.green("✓")} ` })]);
    } else if (s.waiting) {
      this.out.write("\n");
      this.status.set(s.waiting);
    }
  }
  /** Leave step 3's screen as it is (no more redraws). */
  release() {
    this.drawn = false;
    if (this.listening) this.out.removeListener?.("resize", this.onResize);
    this.listening = false;
    this.screen = null;
  }
  /** The view waitForPhone (phone-ready.mjs) talks to. */
  phone({ pairCommand }) {
    const v = this;
    let paired = false;
    const toSignIn = () => {
      if (paired) return;
      paired = true;
      v.release();
      v.status.clear();
      v.out.write(freshScreen(v.size().rows));
      v.write(stepHeader(v.steps, v.steps, "Connect your phone", v.st).slice(1));
      v.done("Your phone is connected.");
      v.write([""]);
      v.write(para(`Now finish on your phone: sign in for your bots, then choose their models. The ${v.product} app shows you how.`, v.size().cols).map((l) => v.st.bold(l)));
      v.write([""]);
      v.busy("Waiting for you to sign in on your phone…");
    };
    return {
      start() {
        // The step-3 screen is up already (pair()); its status line says what we wait for.
      },
      paired: toSignIn,
      signedIn(labels) {
        toSignIn();
        v.done(`Signed in (${labels.join(", ")}).`);
        v.busy("Waiting for you to choose models on your phone…");
      },
      ready({ models, claudeCodeOnly }) {
        toSignIn();
        v.status.clear();
        const rows = [];
        if (models) for (const [role, m] of Object.entries(models)) if (m) rows.push(`${role.padEnd(10)} ${m.provider}/${m.model}${m.thinking ? ` · ${m.thinking}` : ""}`);
        if (claudeCodeOnly && !models) rows.push("Bots run on Claude Code (your Claude plan; it picks the model).");
        if (rows.length) {
          v.done("Models chosen:");
          for (const r of rows) v.write(para(r, v.size().cols, { indent: 4 }).map((l) => v.st.dim(l)));
        }
        v.write(["", ...para(`Your bots are ready. Say hello to your first bot in the ${v.product} app.`, v.size().cols, { first: `${v.st.green("✓")} ` }).map((l) => v.st.bold(l))]);
      },
      timeout() {
        v.release();
        v.status.clear();
        v.write(["", ...para(`Still waiting for your phone. Finish there whenever you like; everything keeps running. Show the code again: ${pairCommand}`, v.size().cols)]);
      },
    };
  }
  /** After the wait: notes that need the user, and how to get the code again. */
  finish({ notes, pairCommand }) {
    this.release();
    this.status.stop();
    const { cols } = this.size();
    this.write(notesBlock(notes.map((n) => this.t(n)), cols, this.st));
    this.write(["", ...para(`Show the pairing code again: ${this.t(pairCommand)}`, cols).map((l) => this.st.dim(l)), ""]);
  }
  close() {
    this.release();
    this.status.stop();
  }
}

/** See SetupView.stepsBlock. Pure (tests). */
export function formatSteps(lines, cols, st = styles(false)) {
  const out = [];
  for (const l of lines) {
    if (!l.trim()) {
      out.push("");
      continue;
    }
    const num = l.match(/^(\d+\.) /);
    const body = num ? l.slice(num[0].length) : l;
    const lead = /^ {2,}\S/.test(l) && !num;
    const [prose, ...rest] = lead ? ["", ...body.trim().split(/ {3,}/)] : body.split(/ {3,}/);
    if (prose) out.push(...para(prose, cols, num ? { first: `${num[1]} ` } : {}));
    rest.forEach((part, i) => {
      if (/^\(.*\)$/.test(part) || (i > 0 && /^\(/.test(part))) out.push(...para(part, cols, { indent: 3 }).map((x) => st.dim(x)));
      else out.push(...codeLines(part, cols, { indent: 3 }));
    });
  }
  return out;
}
