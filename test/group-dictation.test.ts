import { test } from "node:test";
import assert from "node:assert/strict";
import { hostDictation, insertDictation, showsDictationOverlay } from "../client/group-dictation";

test("hostDictation: older apps without the API hide the mic", () => {
  // What the 0.11 runtime module looks like (build 27 and older).
  const old = { Icon() {}, Modal() {}, ScrollView: {}, TextInput: {}, useToast() {} };
  assert.equal(hostDictation(old), null);
  assert.equal(hostDictation(undefined), null);
  assert.equal(hostDictation(null), null);
  assert.equal(hostDictation({ usePluginDictation() {} }), null, "hook without the overlay");
  assert.equal(hostDictation({ DictationOverlay() {} }), null, "overlay without the hook");
});

test("hostDictation: build 28 runtime gives the hook and the overlay", () => {
  const usePluginDictation = () => null;
  const DictationOverlay = () => null;
  const api = hostDictation({ Icon() {}, usePluginDictation, DictationOverlay });
  assert.ok(api);
  assert.equal(api.usePluginDictation, usePluginDictation);
  assert.equal(api.DictationOverlay, DictationOverlay);
  // memo/forwardRef components are objects
  assert.ok(hostDictation({ usePluginDictation, DictationOverlay: { $$typeof: Symbol.for("react.memo") } }));
});

test("showsDictationOverlay: recording, transcribing and failed; not idle", () => {
  assert.equal(showsDictationOverlay("idle", false, false), false);
  assert.equal(showsDictationOverlay("recording", true, false), true);
  assert.equal(showsDictationOverlay("uploading", false, true), true);
  assert.equal(showsDictationOverlay("failed", false, false), true);
});

test("insertDictation: into an empty draft", () => {
  assert.deepEqual(insertDictation("", 0, " check the logs "), { text: "check the logs", cursor: 14 });
});

test("insertDictation: at the end, after a word, adds one space", () => {
  assert.deepEqual(insertDictation("@Otto", 5, "check the logs"), { text: "@Otto check the logs", cursor: 20 });
  assert.deepEqual(insertDictation("@Otto ", 6, "check"), { text: "@Otto check", cursor: 11 });
});

test("insertDictation: mid-text keeps the words apart on both sides", () => {
  assert.deepEqual(insertDictation("@Otto please", 5, "and Ida"), { text: "@Otto and Ida please", cursor: 13 });
  assert.deepEqual(insertDictation("ab", 1, "X"), { text: "a X b", cursor: 3 });
});

test("insertDictation: empty transcript leaves the draft alone; cursor clamped", () => {
  assert.deepEqual(insertDictation("hello", 3, "   "), { text: "hello", cursor: 3 });
  assert.deepEqual(insertDictation("hi", 99, "there"), { text: "hi there", cursor: 8 });
});
