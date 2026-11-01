// The shared envelope fixture (decision 6): bot-dm's writer (formatEnvelope), the envelope parser
// and the plugin's timeline card all agree with test/fixtures/dm/envelopes.jsonl. pi-optchat keeps
// a byte-identical copy and tests its memory tag and memory browser against the same lines.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dmCardData } from "../client/dm-card-data";
import { formatEnvelope, parseEnvelope, type DmEnvelope } from "../shared/dm-schema";

const FIXTURE = join(__dirname, "fixtures", "dm", "envelopes.jsonl");
const raw = readFileSync(FIXTURE, "utf8");
const cases = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { why?: string; text: string; dm: DmEnvelope | null; comment?: string })
  .filter((c) => !c.comment);

test("the fixture has DM and non-DM cases", () => {
  assert.ok(cases.filter((c) => c.dm).length >= 6);
  assert.ok(cases.filter((c) => !c.dm).length >= 5);
});

for (const c of cases) {
  test(`envelope fixture: ${c.why}`, () => {
    assert.deepEqual(parseEnvelope(c.text), c.dm);
    const card = dmCardData(c.text);
    if (!c.dm) return assert.equal(card, null);
    // bot-dm writes exactly this first line.
    assert.equal(formatEnvelope(c.dm), c.text.split("\n")[0]);
    assert.equal(card?.from, c.dm.from);
    // A resume/schedule note on line 2 moves to card.note (shown muted above the body).
    const shown = [card?.note ? `(${card.note})` : null, card?.body].filter(Boolean).join("\n");
    assert.equal(shown, c.text.includes("\n") ? c.text.slice(c.text.indexOf("\n") + 1).trim() : "");
  });
}

test("pi-optchat's copy of the fixture is identical (when the checkout is present)", (t) => {
  // PI_OPTCHAT_DIR, else a pi-optchat checkout next to this one, else ~/code/pi-optchat.
  const candidates = [
    process.env.PI_OPTCHAT_DIR,
    join(__dirname, "..", "..", "pi-optchat"),
    join(homedir(), "code", "pi-optchat"),
  ].filter((d): d is string => Boolean(d));
  const copy = candidates
    .map((d) => join(d, "test", "fixtures", "dm-envelopes.jsonl"))
    .find((f) => existsSync(f));
  if (!copy) return t.skip(`no pi-optchat checkout (${candidates.join(", ")})`);
  assert.equal(readFileSync(copy, "utf8"), raw);
});
