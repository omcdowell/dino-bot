import assert from "node:assert/strict";
import test from "node:test";
import { avatarSvg, setAvatarSvg } from "../client/avatar-svg";
import { registerAvatarSvg } from "../client/host-svg";

test("registerAvatarSvg: the app's SvgXml turns on the JSON path; an older app (no SvgXml) keeps PNGs", () => {
  const SvgXml = () => null;
  try {
    assert.equal(registerAvatarSvg({ SvgXml, Icon: () => null }), true);
    assert.equal(avatarSvg(), SvgXml);
    assert.equal(registerAvatarSvg({ Icon: () => null }), false, "older app");
    assert.equal(avatarSvg(), null);
    const memo = { $$typeof: Symbol.for("react.memo"), type: SvgXml };
    assert.equal(registerAvatarSvg({ SvgXml: memo }), true, "a memo/forwardRef component counts");
    assert.equal(registerAvatarSvg(undefined), false);
    assert.equal(avatarSvg(), null);
  } finally {
    setAvatarSvg(null);
  }
});
