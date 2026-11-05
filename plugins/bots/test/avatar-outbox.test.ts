// AV3: the avatar save outbox (optimistic save, offline queue, revisions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AVATAR_PACK, type AvatarJson } from "../shared/avatar";
import { AvatarApiUnavailable, STUB_AVATAR_API, type AvatarSaveResult } from "../client/avatar-api";
import {
  EMPTY_OUTBOX,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  applySaveFailure,
  applySaveResult,
  drainOutbox,
  dueSaves,
  enqueueSave,
  highestRevision,
  nextDueAt,
  nextRevision,
  noteHostRevision,
  normaliseOutbox,
  optimisticAvatar,
  retryDelay,
  retryNow,
  saveStatus,
  type AvatarOutbox,
} from "../client/avatar-outbox";

const avatar = (over: Partial<AvatarJson> = {}): AvatarJson => ({
  v: 1,
  packVersion: AVATAR_PACK.packVersion,
  character: "emmet-boxfish",
  eyes: "original",
  accessories: [{ id: "box-cap", x: 0.5, y: 0.2, scale: 0.3 }],
  revision: 0,
  ...over,
});

test("enqueue gives revisions that count up per bot, from the highest the device knows", () => {
  let box: AvatarOutbox = EMPTY_OUTBOX;
  let r = enqueueSave(box, "emmet", avatar(), 1000);
  assert.equal(r.avatar.revision, 1);
  box = r.box;
  r = enqueueSave(box, "emmet", avatar({ eyes: "dot" }), 1001);
  assert.equal(r.avatar.revision, 2);
  box = r.box;
  // another bot starts at 1
  assert.equal(enqueueSave(box, "luna", avatar(), 1002).avatar.revision, 1);
  // the host reported a higher stored revision (another device saved): the next save goes above it
  box = noteHostRevision(box, "emmet", 7);
  assert.equal(nextRevision(box, "emmet"), 8);
  // a lower report never lowers it
  assert.equal(noteHostRevision(box, "emmet", 3), box);
  assert.equal(highestRevision(box, "nobody"), 0);
});

test("a newer save replaces the queued one (one pending save per bot) and is drawn at once", () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000, "hashA").box;
  box = enqueueSave(box, "emmet", avatar({ eyes: "happy" }), 1100, "hashA").box;
  const due = dueSaves(box, 2000);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.avatar.eyes, "happy");
  assert.equal(due[0]!.avatar.revision, 2);
  assert.equal(optimisticAvatar(box.bots.emmet, "hashA")?.eyes, "happy");
  assert.equal(saveStatus(box.bots.emmet), "sending");
});

test("ok: the pending save clears; the device keeps drawing it until the bot list's hash moves on", () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000, "old").box;
  box = applySaveResult(box, "emmet", 1, { ok: true, revision: 1, hash: "new" }, 1500);
  const e = box.bots.emmet!;
  assert.equal(e.pending, undefined);
  assert.equal(e.known, 1);
  assert.equal(optimisticAvatar(e, "old")?.revision, 1, "host has not re-rendered yet: keep the local picture");
  assert.equal(optimisticAvatar(e, "new"), null, "hash moved on: the host's PNG is current");
  assert.equal(saveStatus(e), null);
});

test("an answer for an older revision does not clear a newer queued save", () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000).box; // rev 1 in flight
  box = enqueueSave(box, "emmet", avatar({ eyes: "dot" }), 1100).box; // rev 2 queued meanwhile
  box = applySaveResult(box, "emmet", 1, { ok: true, revision: 1 }, 1200);
  assert.equal(box.bots.emmet!.pending?.avatar.revision, 2);
  assert.equal(box.bots.emmet!.known, 1);
  // and a failure of rev 1 leaves rev 2 alone
  const failed = applySaveFailure(box, "emmet", 1, "offline", 1300);
  assert.equal(failed, box);
});

test("stale: the host has a newer save, so the queued one is dropped and never resent", () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000, "h").box;
  box = applySaveResult(box, "emmet", 1, { ok: false, reason: "stale", currentRevision: 5 }, 1100);
  const e = box.bots.emmet!;
  assert.equal(e.pending, undefined);
  assert.equal(e.saved, undefined, "stop drawing the losing copy");
  assert.equal(e.known, 5);
  assert.equal(saveStatus(e), "stale");
  assert.deepEqual(dueSaves(box, 1e12), []);
  // the next save goes above the host's
  assert.equal(enqueueSave(box, "emmet", avatar(), 1200).avatar.revision, 6);
});

test("stale for an older in-flight save keeps a newer queued save that is above the host's revision", () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000).box; // rev 1
  box = noteHostRevision(box, "emmet", 0);
  box = enqueueSave(box, "emmet", avatar({ eyes: "dot" }), 1001).box; // rev 2
  box = enqueueSave(box, "emmet", avatar({ eyes: "pill" }), 1002).box; // rev 3 (replaces 2)
  box = applySaveResult(box, "emmet", 1, { ok: false, reason: "stale", currentRevision: 2 }, 1100);
  assert.equal(box.bots.emmet!.pending?.avatar.revision, 3);
  assert.equal(box.bots.emmet!.saved?.eyes, "pill");
});

test("invalid: dropped with its error, not retried", () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000).box;
  box = applySaveResult(box, "emmet", 1, { ok: false, reason: "invalid", error: "unknown accessory" }, 1100);
  assert.equal(box.bots.emmet!.pending, undefined);
  assert.equal(box.bots.emmet!.saved, undefined);
  assert.equal(box.bots.emmet!.dropped?.error, "unknown accessory");
  assert.equal(saveStatus(box.bots.emmet), "invalid");
});

test("offline: kept queued with backoff (2 s doubling, max 5 min); retryNow sends at once", () => {
  assert.equal(retryDelay(1), RETRY_BASE_MS);
  assert.equal(retryDelay(2), RETRY_BASE_MS * 2);
  assert.equal(retryDelay(30), RETRY_MAX_MS);
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000).box;
  box = applySaveFailure(box, "emmet", 1, "offline", 1000);
  box = applySaveFailure(box, "emmet", 1, "offline", 3000);
  const p = box.bots.emmet!.pending!;
  assert.equal(p.attempts, 2);
  assert.equal(p.nextAt, 3000 + 2 * RETRY_BASE_MS);
  assert.equal(p.lastError, "offline");
  assert.equal(saveStatus(box.bots.emmet), "queued");
  assert.deepEqual(dueSaves(box, 4000), []);
  assert.equal(nextDueAt(box), 7000);
  box = retryNow(box, 4000);
  assert.equal(dueSaves(box, 4000).length, 1);
  assert.equal(retryNow(box, 4000), box, "nothing to move: same object");
});

test("the outbox survives a round trip through device storage; junk is dropped", () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar({ colour: "#FF6A59" }), 1000, null).box;
  box = applySaveFailure(box, "emmet", 1, "offline", 1000);
  const back = normaliseOutbox(JSON.parse(JSON.stringify(box)));
  assert.deepEqual(back, box);
  assert.deepEqual(normaliseOutbox(null), EMPTY_OUTBOX);
  assert.deepEqual(normaliseOutbox({ v: 2, bots: {} }), EMPTY_OUTBOX);
  const junk = normaliseOutbox({ v: 1, bots: { a: 5, b: { known: "x", pending: { avatar: { v: 9 } } }, c: { known: 3 } } });
  assert.deepEqual(junk, { v: 1, bots: { b: { known: 0 }, c: { known: 3 } } });
});

test("drainOutbox sends due saves once per bot and folds the answers in", async () => {
  let box: AvatarOutbox = EMPTY_OUTBOX;
  box = enqueueSave(box, "emmet", avatar(), 1000).box;
  box = enqueueSave(box, "luna", avatar({ character: "whale", accessories: [] }), 1001).box;
  box = noteHostRevision(box, "rex", 4);
  box = enqueueSave(box, "rex", avatar(), 1002).box; // rev 5; host says stale (6)
  const sent: string[] = [];
  const answers: Record<string, AvatarSaveResult | Error> = {
    emmet: { ok: true, revision: 1 },
    luna: new Error("offline"),
    rex: { ok: false, reason: "stale", currentRevision: 6 },
  };
  const api = {
    save: async ({ botId, avatar: a }: { botId: string; avatar: AvatarJson }) => {
      sent.push(`${botId}@${a.revision}`);
      const r = answers[botId]!;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const landed = await drainOutbox(() => box, (u) => { box = u(box); }, api, () => 2000);
  assert.equal(landed, 1);
  assert.deepEqual(sent.sort(), ["emmet@1", "luna@1", "rex@5"]);
  assert.equal(box.bots.emmet!.pending, undefined);
  assert.equal(box.bots.luna!.pending?.attempts, 1);
  assert.equal(box.bots.rex!.pending, undefined);
  assert.equal(box.bots.rex!.known, 6);
  // nothing due until luna's backoff
  sent.length = 0;
  await drainOutbox(() => box, (u) => { box = u(box); }, api, () => 2001);
  assert.deepEqual(sent, []);
});

test("drainOutbox keeps a save queued meanwhile, and skips bots already in flight", async () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000).box;
  const api = {
    save: async () => {
      // the user saves again while rev 1 is on the wire
      box = enqueueSave(box, "emmet", avatar({ eyes: "wide" }), 1500).box;
      return { ok: true as const, revision: 1 };
    },
  };
  await drainOutbox(() => box, (u) => { box = u(box); }, api, () => 2000);
  assert.equal(box.bots.emmet!.pending?.avatar.revision, 2);
  const inFlight = new Set(["emmet"]);
  let calls = 0;
  await drainOutbox(() => box, (u) => { box = u(box); }, { save: async () => { calls++; return { ok: true as const, revision: 2 }; } }, () => 3000, inFlight);
  assert.equal(calls, 0);
});

test("until AV1 lands the stub never sends: saves stay queued on the device", async () => {
  let box = enqueueSave(EMPTY_OUTBOX, "emmet", avatar(), 1000).box;
  await assert.rejects(STUB_AVATAR_API.save({ botId: "emmet", avatar: avatar() }), AvatarApiUnavailable);
  await drainOutbox(() => box, (u) => { box = u(box); }, STUB_AVATAR_API, () => 2000);
  assert.equal(box.bots.emmet!.pending?.attempts, 1);
  assert.match(box.bots.emmet!.pending!.lastError!, /cannot save/);
  assert.equal(optimisticAvatar(box.bots.emmet, null)?.revision, 1);
});
