import assert from "node:assert/strict";
import test from "node:test";
import { fromSaveWire, useAvatarApiFrom } from "../client/avatar-api";
import { SaveAvatarResultSchema } from "../shared/avatar-rpc";

test("AV1 save answers map to the outbox's results", () => {
  const saved = SaveAvatarResultSchema.parse({ ok: true, reason: "saved", revision: 3, hash: "h".repeat(16), unchanged: false, renderMs: 8 });
  assert.deepEqual(fromSaveWire(saved), { ok: true, revision: 3, hash: "h".repeat(16) });
  assert.deepEqual(fromSaveWire({ ok: false, reason: "stale", revision: 7, hash: null }), { ok: false, reason: "stale", currentRevision: 7 });
  assert.deepEqual(fromSaveWire({ ok: false, reason: "invalid", error: "no eye x", packVersion: 1 }), {
    ok: false,
    reason: "invalid",
    error: "no eye x",
  });
});

test("useAvatarApiFrom passes calls through and keeps thrown errors (not sent: retried)", async () => {
  const calls: unknown[] = [];
  const api = useAvatarApiFrom(
    async (input) => {
      calls.push(input);
      return { ok: false, reason: "stale", revision: 9, hash: "x".repeat(16) };
    },
    async () => ({ avatar: null, hash: null, live: false }) as never,
  );
  const avatar = { packVersion: 1, revision: 2 } as never;
  assert.deepEqual(await api.save({ botId: "emmet", avatar }), { ok: false, reason: "stale", currentRevision: 9 });
  assert.deepEqual(calls, [{ botId: "emmet", avatar }]);
  assert.deepEqual(await api.get({ botId: "emmet" }), { avatar: null });
  const offline = useAvatarApiFrom(() => Promise.reject(new Error("offline")), () => Promise.reject(new Error("offline")));
  await assert.rejects(offline.save({ botId: "emmet", avatar }), /offline/);
});
