import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOTTOM_GUARD,
  CIRCLE_SIZE,
  CIRCLES_OFFSET,
  HELD_SQUARE,
  circlesPlacement,
  effectiveHomeState,
  heldPill,
  heldRowContent,
  heldSquare,
  heldTileContent,
  criticalSpringTime,
  PILL_AVATAR_PADDING,
  ROW_PADDING,
  PILL_LIFT_SCALE,
  PILL_MARGIN,
  homeLayout,
  pinCircle,
  pinnedAvatarSize,
  pinnedColumns,
  PINNED_LABEL_GAP,
  SCREEN_MARGIN,
  sidebarOrder,
  toggleLead,
  leadHint,
  toggleMember,
} from "../client/manage-format";
import { PIN_FULL_MESSAGE, type HomeState } from "../shared/manage";

const bot = (id: string, featured = false) => ({ id, name: id.toUpperCase(), order: featured ? 0 : 10, featured });
const BOTS = [bot("fc", true), bot("emmet"), bot("peggy"), bot("scrat"), bot("flint")];
const GROUPS = [{ id: "alarm", name: "Alarm Clock", lastTs: "2026-10-13T07:30:00Z" }];
const AT: Record<string, string> = {
  fc: "2026-10-13T08:00:00Z",
  emmet: "2026-10-13T07:00:00Z",
  peggy: "2026-10-13T07:45:00Z",
  scrat: "2026-10-13T06:00:00Z",
};
const at = (b: { id: string }) => AT[b.id] ?? null;
const state = (pins: string[], archived: Record<string, string> = {}): HomeState => ({ v: 1, pins, archived });
const keys = (rows: Array<{ key: string }>) => rows.map((r) => r.key);

test("before the host answers, the featured bot is pinned (today's home)", () => {
  assert.deepEqual(effectiveHomeState(undefined, BOTS), state(["bot:fc"]));
  assert.deepEqual(effectiveHomeState(undefined, [bot("a")]), state([]));
  const s = state(["bot:emmet"]);
  assert.equal(effectiveHomeState(s, BOTS), s);
});

test("pinned items come first in pin order; the rest mingle by recency, FC included once unpinned", () => {
  const layout = homeLayout(BOTS, GROUPS, state(["bot:emmet", "group:alarm"]), at);
  assert.deepEqual(keys(layout.pinned), ["bot:emmet", "group:alarm"]);
  assert.deepEqual(keys(layout.rows), ["fc", "peggy", "scrat", "flint"]);
  assert.deepEqual(keys(sidebarOrder(layout)), ["bot:emmet", "group:alarm", "fc", "peggy", "scrat", "flint"]);
});

test("archived bots and groups are hidden everywhere and listed newest first", () => {
  const layout = homeLayout(
    BOTS,
    GROUPS,
    state(["bot:fc", "bot:peggy"], { "bot:peggy": "2026-10-13T01:00:00Z", "group:alarm": "2026-10-13T02:00:00Z", "bot:gone": "x" }),
    at,
  );
  assert.deepEqual(keys(layout.pinned), ["bot:fc"]);
  assert.deepEqual(keys(layout.rows), ["emmet", "scrat", "flint"]);
  assert.deepEqual(keys(layout.archived), ["group:alarm", "bot:peggy"]);
});

test("at most three pinned are drawn; unknown pins are skipped", () => {
  const layout = homeLayout(BOTS, GROUPS, state(["bot:nobody", "bot:fc", "bot:emmet", "bot:peggy", "bot:scrat"]), at);
  assert.deepEqual(keys(layout.pinned), ["bot:fc", "bot:emmet", "bot:peggy"]);
  assert.ok(keys(layout.rows).includes("scrat"));
});

test("pin circle: Unpin when pinned, greyed with Sam's message when three are pinned", () => {
  const full = state(["bot:fc", "bot:emmet", "group:alarm"]);
  assert.deepEqual(pinCircle(full, "bot:fc"), { pinned: true, disabled: false, message: null });
  assert.deepEqual(pinCircle(full, "bot:peggy"), { pinned: false, disabled: true, message: PIN_FULL_MESSAGE });
  assert.deepEqual(pinCircle(state(["bot:fc"]), "bot:peggy"), { pinned: false, disabled: false, message: null });
});

test("pinned row: three equal columns, the ones present spread evenly", () => {
  const W = 402;
  const three = pinnedColumns(3, W);
  assert.ok(Math.abs(three.columnWidth - (W - 32) / 3) < 1e-9);
  assert.equal(three.centres.length, 3);
  assert.ok(Math.abs(three.centres[1]! - W / 2) < 1e-9, "middle column centred");
  assert.ok(Math.abs(three.centres[0]! - (W - three.centres[2]!)) < 1e-9, "symmetric");
  assert.deepEqual(pinnedColumns(1, W).centres, [W / 2]);
  const two = pinnedColumns(2, W).centres;
  assert.ok(Math.abs(two[0]! + two[1]! - W) < 1e-9);
  assert.deepEqual(pinnedColumns(0, W).centres, []);
  assert.equal(pinnedColumns(5, W).centres.length, 3);
  assert.equal(pinnedAvatarSize(1), 88);
  assert.equal(pinnedAvatarSize(3), 68);
});

test("pinned names: as wide as the room they really have, never colliding", () => {
  const W = 402;
  // Alone: the whole screen minus margins (Sam 13 Oct: "The Fat Contr…").
  const one = pinnedColumns(1, W);
  assert.equal(one.labelWidth, W - 2 * SCREEN_MARGIN);
  assert.ok(one.labelWidth > one.columnWidth);
  for (const n of [2, 3]) {
    const cols = pinnedColumns(n, W);
    const spacing = cols.centres[1]! - cols.centres[0]!;
    assert.ok(Math.abs(cols.labelWidth - (spacing - PINNED_LABEL_GAP)) < 1e-9, `${n}: spacing minus gap`);
    assert.ok(cols.labelWidth >= cols.columnWidth - 4, `${n}: never narrower than before`);
    // Neighbouring names keep the gap; outer names stay on screen.
    assert.ok(cols.centres[0]! + cols.labelWidth / 2 + PINNED_LABEL_GAP <= cols.centres[1]! - cols.labelWidth / 2 + 1e-9);
    assert.ok(cols.centres[0]! - cols.labelWidth / 2 >= -1e-9);
    assert.ok(cols.centres[n - 1]! + cols.labelWidth / 2 <= W + 1e-9);
  }
  assert.ok(pinnedColumns(2, W).labelWidth > pinnedColumns(3, W).labelWidth);
  // Centres unchanged by the label width.
  assert.deepEqual(pinnedColumns(1, W).centres, [W / 2]);
  assert.equal(pinnedColumns(0, W).labelWidth >= 0, true);
  assert.equal(pinnedColumns(1, 10).labelWidth, 0);
});

test("held pinned square: fixed size, same height, slides sideways only to the centre", () => {
  const W = 402;
  const [left, middle, right] = pinnedColumns(3, W).centres;
  const tile = (cx: number) => ({ x: cx - 60, y: 120, width: 120, height: 150 });
  const l = heldSquare(tile(left!), W);
  const m = heldSquare(tile(middle!), W);
  const r = heldSquare(tile(right!), W);
  for (const s of [l, m, r]) {
    assert.equal(s.top, Math.round(120 + 75 - HELD_SQUARE / 2));
    assert.equal(s.endLeft, Math.round(W / 2 - HELD_SQUARE / 2));
  }
  assert.ok(l.startLeft < l.endLeft, "left slides right");
  assert.equal(m.startLeft, m.endLeft, "middle lifts in place");
  assert.ok(r.startLeft > r.endLeft, "right slides left");
});

test("held row: pill in place, 16 pt from each edge once lifted to 102%", () => {
  const pill = heldPill({ x: 0, y: 500, width: 402, height: 88 }, 402);
  assert.equal(pill.y, 500);
  assert.equal(pill.height, 88);
  assert.equal(pill.x + pill.width / 2, 201);
  const lifted = pill.width * PILL_LIFT_SCALE;
  assert.ok(Math.abs((402 - lifted) / 2 - PILL_MARGIN) < 0.1, `lifted margin ${(402 - lifted) / 2}`);
});

test("held row: the one content layer is the resting row, scaled to sit 14 pt inside the lifted pill", () => {
  const row = { x: 0, y: 500, width: 402, height: 88 };
  const { scale, shiftX } = heldRowContent(row, 402);
  assert.equal(shiftX, 0);
  // Resting content spans [16, 386]; scaled about the centre (201) it must span [30, 372].
  const left = 201 - scale * (201 - ROW_PADDING);
  assert.ok(Math.abs(left - (PILL_MARGIN + PILL_AVATAR_PADDING)) < 0.1, `left ${left}`);
  assert.ok(scale > 0.9 && scale < 1);
});

test("held pinned tile: avatar becomes 72 pt, content centred in the square", () => {
  const tile = { x: 16, y: 120, width: 123, height: 160 };
  const small = heldTileContent(tile, 68);
  assert.ok(Math.abs(small.scale - 72 / 68) < 1e-9);
  // The tile pads 8 above and 20 below: shift down by half the difference, scaled.
  assert.ok(Math.abs(small.shiftY - 6 * small.scale) < 1e-9);
  const big = heldTileContent(tile, 88);
  assert.ok(Math.abs(big.scale - 72 / 88) < 1e-9);
  // A tall tile is capped so its content fits the square with 12 pt to spare.
  const tall = heldTileContent({ ...tile, height: 220 }, 68);
  assert.ok(tall.scale * (220 - 28) <= HELD_SQUARE - 24 + 1e-9);
});

test("criticalSpringTime: when a released critically damped spring is within a fraction of rest", () => {
  assert.equal(criticalSpringTime(0.01, 0.02, 320, 1), 0);
  const t = criticalSpringTime(1, 0.02, 320, 1);
  const u = (Math.sqrt(320) * t) / 1000;
  assert.ok(Math.abs((1 + u) * Math.exp(-u) - 0.02) < 1e-6);
  assert.ok(t > 300 && t < 350, `${t}`);
  assert.ok(criticalSpringTime(0.5, 0.02, 320, 1) < t);
});

test("circles: 22 pt below, or above when within 34 pt of the bottom", () => {
  const H = 874;
  assert.deepEqual(circlesPlacement(500, 88, H), { top: 500 + 88 + CIRCLES_OFFSET, where: "below" });
  const lastRow = 874 - 34 - 88;
  const placed = circlesPlacement(lastRow, 88, H);
  assert.equal(placed.where, "above");
  assert.equal(placed.top, lastRow - CIRCLES_OFFSET - CIRCLE_SIZE);
  // Exactly fitting still goes below.
  const fits = H - BOTTOM_GUARD - CIRCLE_SIZE - CIRCLES_OFFSET - 88;
  assert.equal(circlesPlacement(fits, 88, H).where, "below");
  assert.equal(circlesPlacement(fits + 1, 88, H).where, "above");
});

test("group editor: members and leads", () => {
  let e = { members: [] as string[], leads: [] as string[] };
  e = toggleMember(e, "wallace");
  assert.deepEqual(e, { members: ["wallace"], leads: ["wallace"] });
  e = toggleMember(e, "peggy");
  assert.deepEqual(e.leads, ["wallace"]);
  e = toggleLead(e, "peggy");
  assert.deepEqual(e.leads, ["wallace", "peggy"]);
  assert.equal(toggleLead(e, "scrat"), e);
  e = toggleMember(e, "wallace");
  assert.deepEqual(e, { members: ["peggy"], leads: ["peggy"] });
});

test("dark surface detection", async () => {
  const { isDarkSurface } = await import("../client/manage-format");
  assert.equal(isDarkSurface("#181B1A"), true);
  assert.equal(isDarkSurface("#FFFFFF"), false);
  assert.equal(isDarkSurface("#fff"), false);
  assert.equal(isDarkSurface("rgb(0,0,0)"), false);
});

test("lead hint: click on desktop/web, tap on phones", () => {
  assert.equal(leadHint("web"), "click to make lead");
  assert.equal(leadHint("ios"), "tap to make lead");
  assert.equal(leadHint("android"), "tap to make lead");
});
