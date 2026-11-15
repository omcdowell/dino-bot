// `dinobot doctor`'s sign-in line counts Claude Code's login (RV11: a Claude-Code-only install read
// "FAIL sign-in: no AI sign-in found").   node --test test/doctor-signin.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signInCheck } from "../lib/doctor.mjs";

const none = { found: [] };
const pi = { found: [{ subscription: "chatgpt-plus", source: "dinobot" }] };
const ccIn = { installed: true, loggedIn: true, plan: "Max plan" };
const ccOut = { installed: true, loggedIn: false, plan: null };

describe("doctor sign-in", () => {
  it("Claude Code only, logged in: ok, named", () => {
    const r = signInCheck(none, ccIn);
    assert.equal(r.status, "ok");
    assert.equal(r.detail, "Claude Code (Max plan)");
  });
  it("nothing at all: FAIL with the fix", () => {
    for (const cc of [ccOut, { installed: false, loggedIn: false }, null]) {
      const r = signInCheck(none, cc);
      assert.equal(r.status, "FAIL");
      assert.match(r.fix, /setup|sign in from the app/);
    }
  });
  it("pi and Claude Code: both listed", () => {
    assert.deepEqual(signInCheck(pi, ccIn), { status: "ok", detail: "chatgpt-plus (dinobot), Claude Code (Max plan)" });
    assert.deepEqual(signInCheck(pi, ccOut), { status: "ok", detail: "chatgpt-plus (dinobot)" });
  });
});
