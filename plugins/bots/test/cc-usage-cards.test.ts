// Plan usage cards for Claude Code bots (UC1): server/cc/usage-source.ts answers the usage scope Paseo builds from a
// plugin session (provider optchat-cc, launch env with PASEO_AGENT_CWD) from the windows the bot's TUI reported.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { UsageReportSchema } from "@getpaseo/protocol/messages";
import { createCcUsageSource } from "../server/cc/usage-source";
import { CcUsageLedger } from "../server/cc/usage";

const TMP = mkdtempSync(join(tmpdir(), "cc-usage-cards-"));
const ROOT = join(TMP, "bots");
const STATE = join(ROOT, ".cc");
const NOW = Date.parse("2026-11-15T12:00:00Z");
const source = createCcUsageSource({ botsRoot: ROOT, botDir: (bot) => join(STATE, bot), provider: "optchat-cc", now: () => NOW });

const scope = (bot: string, extra: Record<string, string> = {}) => ({
  kind: "session" as const,
  provider: "optchat-cc",
  model: "sonnet",
  env: { PASEO_AGENT_ID: "a1", PASEO_AGENT_CWD: join(ROOT, bot), ...extra },
});
function ledger(bot: string, data: object) {
  mkdirSync(join(STATE, bot), { recursive: true });
  writeFileSync(join(STATE, bot, "usage.json"), JSON.stringify({ v: 1, runs: {}, sessions: {}, ...data }));
}
const replied = { runs: { "s:1": { usd: 0.01, input: 10, cached: 0, output: 5 } } };

describe("cc usage cards: discovery", () => {
  it("answers only optchat-cc chats in a bot folder", async () => {
    ledger("kit", { ...replied, rateLimits: [{ kind: "five_hour", percentUsed: 10 }] });
    assert.deepEqual(await source.discover({ kind: "global" }), []);
    assert.deepEqual(await source.discover({ ...scope("kit"), provider: "pi" }), []);
    assert.deepEqual(await source.discover({ ...scope("kit"), env: {} }), []);
    assert.deepEqual(await source.discover({ ...scope("kit"), env: { PASEO_AGENT_CWD: join(TMP, "elsewhere", "kit") } }), []);
    assert.deepEqual(await source.discover({ ...scope("kit"), env: { PASEO_AGENT_CWD: ROOT } }), []);
    const [account, ...rest] = await source.discover(scope("kit"));
    assert.equal(rest.length, 0);
    assert.deepEqual({ ...account, key: undefined }, { key: undefined, label: "kit", harness: "Claude Code", input: { bot: "kit" } });
    assert.match(account!.key, /^[a-f0-9]{64}$/);
    // The same bot gives the same account whatever the chat (the registry groups its cards by key).
    assert.equal((await source.discover(scope("kit", { PASEO_AGENT_ID: "a2" })))[0]!.key, account!.key);
  });

  it("a bot that replied but never got windows (API key, proxy) gets no card; one with no reply yet gets one", async () => {
    ledger("proxied", replied);
    assert.deepEqual(await source.discover(scope("proxied")), []);
    // Only the start-of-run estimate so far (no reply): the login is not known yet.
    ledger("fresh", { runs: { "s:1": { usd: 0, input: 0, cached: 0, output: 0 } } });
    assert.equal((await source.discover(scope("fresh"))).length, 1);
    assert.equal((await source.discover(scope("never-started"))).length, 1);
    const pending = await source.fetch({ bot: "fresh" });
    assert.deepEqual(pending, { status: "unavailable", problem: { kind: "no_quota", detail: "Plan limits show after the bot's first reply." } });
    UsageReportSchema.parse(pending);
    const none = await source.fetch({ bot: "proxied" });
    assert.equal(none.status, "unavailable");
    UsageReportSchema.parse(none);
  });
});

describe("cc usage cards: the report", () => {
  it("Claude Code's windows as the Claude source's (ids, labels, order, tones), with how old they are", async () => {
    ledger("kit", {
      ...replied,
      rateLimitsAt: "2026-11-15T11:48:00Z",
      rateLimits: [
        { kind: "spend_limit", percentUsed: 120, resetsAt: "2026-12-01T00:00:00Z" },
        { kind: "seven_day", percentUsed: 75.5, resetsAt: "2026-11-20T00:00:00Z" },
        { kind: "five_hour", percentUsed: 12, resetsAt: "2026-11-15T14:00:00Z" },
        { kind: "five_hour", percentUsed: 99 },
        { kind: "bad", percentUsed: "x" },
        { kind: "", percentUsed: 1 },
        { kind: "seven_day_sonnet", percentUsed: 95 },
      ],
    });
    const report = await source.fetch({ bot: "kit" });
    UsageReportSchema.parse(report);
    assert.equal(report.status, "available");
    if (report.status !== "available") return;
    assert.deepEqual(report.windows, [
      { id: "five_hour", label: "Session", shortLabel: "5h", summary: true, usedPct: 12, remainingPct: 88, resetsAt: "2026-11-15T14:00:00Z", tone: "ok" },
      { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: 75.5, remainingPct: 24.5, resetsAt: "2026-11-20T00:00:00Z", tone: "warning" },
      { id: "spend_limit", label: "Spend limit", shortLabel: "$", usedPct: 120, remainingPct: 0, resetsAt: "2026-12-01T00:00:00Z", tone: "danger" },
      { id: "seven_day_sonnet", label: "Seven day sonnet", shortLabel: "", usedPct: 95, remainingPct: 5, resetsAt: null, tone: "danger" },
    ]);
    assert.deepEqual(report.details, [{ id: "reported", label: "Reported", value: "12 min ago" }]);
  });

  it("a window whose reset has passed since it was reported shows no stale figure", async () => {
    ledger("kit", { ...replied, rateLimits: [{ kind: "five_hour", percentUsed: 97, resetsAt: "2026-11-15T11:00:00Z" }, { kind: "seven_day", percentUsed: 40, resetsAt: "2026-11-20T00:00:00Z" }] });
    const report = await source.fetch({ bot: "kit" });
    assert.equal(report.status, "available");
    if (report.status !== "available") return;
    assert.deepEqual(report.windows[0], { id: "five_hour", label: "Session", shortLabel: "5h", summary: true, usedPct: null, remainingPct: null, resetsAt: null, tone: "default" });
    assert.equal(report.windows[1]!.usedPct, 40);
    assert.deepEqual(report.details, []); // an older ledger has no rateLimitsAt
  });

  it("refuses an input that is not a bot name (no paths)", async () => {
    await assert.rejects(source.fetch({ bot: "../x" }));
    await assert.rejects(source.fetch({ bot: "kit", path: "/etc" }));
  });

  it("reads what the ledger writes: the TUI's report lands as cards, stamped when", async () => {
    const l = new CcUsageLedger(join(STATE, "round", "usage.json"), () => Date.parse("2026-11-15T11:59:00Z"));
    l.run("chat", { run: "s:1", costUsd: 0.02, tokens: { output_tokens: 3 }, rateLimits: [{ kind: "five_hour", percentUsed: 3, resetsAt: "2026-11-15T15:00:00Z" }] });
    // A later report without windows (e.g. the start-of-run estimate) keeps the last ones.
    l.run("chat", { run: "s:2", rateLimits: [] });
    assert.equal((await source.discover(scope("round"))).length, 1);
    const report = await source.fetch({ bot: "round" });
    assert.equal(report.status, "available");
    if (report.status !== "available") return;
    assert.deepEqual(report.windows.map((w) => [w.id, w.usedPct]), [["five_hour", 3]]);
    assert.deepEqual(report.details, [{ id: "reported", label: "Reported", value: "1 min ago" }]);
  });

  it("is registered with the Claude icon from the plugin folder", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const icon = join(import.meta.dirname, "..", source.icon!);
    assert.ok(existsSync(icon));
    assert.match(readFileSync(icon, "utf8"), /^<svg /);
    assert.equal(source.id, "optchat-cc");
    assert.equal(source.label, "Claude");
  });

  it("stands in for the Claude sign-in card: a host list with that card leaves this one out", () => {
    assert.deepEqual(source.fallbackFor, ["claude"]);
  });
});
