// release/app: host settings, templates, one-call bot creation and Delete bot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotFiles, CREATE_MISSING_STEPS, HomeStateFile, ManageError } from "../server/manage";
import { parseSettings, readSettingsAt } from "../server/settings";
import { stripProfiles, withoutBotDmBlock } from "../server/bot-dm-block";
import { BOT_TEMPLATES, agentsMdFor, suggestedTemplate, templateById } from "../shared/templates";
import { botChatConfig } from "../server/bots";
import { checkAllowed, checkPair } from "../bot-dm/policy";

function tempHost() {
  const base = mkdtempSync(join(process.env.BM_TEST_TMP ?? tmpdir(), "rel-app-"));
  const root = join(base, "bots");
  const optchatHome = join(base, "optchat");
  mkdirSync(root, { recursive: true });
  return { base, root, optchatHome, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("settings: the merged schema still covers the release/app keys (user name, escalation, add-on config)", () => {
  const s = parseSettings({});
  assert.equal(s.user.name, "the user");
  assert.equal(s.escalation, null);
  assert.deepEqual(s.addons, {});
  const sam = parseSettings({
    user: { name: "Sam" },
    escalation: "coordinator",
    addons: { usage: { url: "http://x:1", consumer: "c", label: "c pool" } },
  });
  assert.equal(sam.user.name, "Sam");
  assert.equal(sam.escalation, "coordinator");
  assert.deepEqual(sam.addons.usage, { url: "http://x:1", consumer: "c", label: "c pool" });
  assert.equal(parseSettings({ escalation: "../etc" }).escalation, null);
  assert.deepEqual(parseSettings({ addons: ["nope"] }).addons, {});
});

test("settings: read from <root>/.settings.json for a given root; a bad file reads as defaults", () => {
  const h = tempHost();
  try {
    writeFileSync(join(h.root, ".settings.json"), JSON.stringify({ user: { name: "Sam" } }));
    assert.equal(readSettingsAt(h.root, {}).user.name, "Sam");
    writeFileSync(join(h.root, ".settings.json"), "{nope");
    assert.equal(readSettingsAt(h.root, {}).user.name, "the user");
  } finally {
    h.done();
  }
});

test("policy: with no escalation bot, escalate is refused with advice and every pair is PM <-> PM", () => {
  const r = checkAllowed("flint", "scrat", "escalate", "");
  assert.equal(r?.reason, "no escalation bot is set on this host");
  assert.equal(checkAllowed("flint", "scrat", "request", ""), null);
  assert.match(checkAllowed("flint", "scrat", "resume", "")?.reason ?? "", /reserved for system senders/);
  assert.match(checkPair(10, "flint", "scrat", "info", "")?.advice ?? "", /Stop the exchange here and decide, or ask/);
});

test("templates: coordinator suggested for the first bot only; AGENTS.md from template + purpose", () => {
  assert.equal(suggestedTemplate(0), "coordinator");
  assert.equal(suggestedTemplate(3), "blank");
  assert.deepEqual(BOT_TEMPLATES.map((t) => t.id), ["coordinator", "researcher", "writer", "coder", "blank"]);
  assert.equal(templateById("nope").id, "blank");
  const md = agentsMdFor({ name: "Margot", template: "researcher", purpose: "  Finds  papers " });
  assert.match(md, /^# Margot\n\nWhat Margot is for: Finds papers\n\nMargot researches questions/);
  assert.equal(agentsMdFor({ name: "Blank", template: "blank" }), "# Blank\n\nBlank: describe what this bot is for in one line.\n");
});

test("bot-dm block: stripped from AGENTS.md with the blank lines before it; text without one is unchanged", () => {
  const block = "<!-- bot-dm:begin v1 -->\n## Bot-to-bot DMs\n\nrules\n<!-- bot-dm:end -->\n";
  assert.equal(withoutBotDmBlock(`# A\n\nRole.\n\n${block}`), "# A\n\nRole.\n");
  assert.equal(withoutBotDmBlock(`# A\n\n${block}\n## Mine\nkept\n`), "# A\n\n## Mine\nkept\n");
  assert.equal(withoutBotDmBlock("# A\n"), "# A\n");
  assert.equal(withoutBotDmBlock(block), "");
});

test("stripProfiles: backs up, strips once, keeps the mode, leaves other profiles alone", () => {
  const h = tempHost();
  try {
    const prof = (name: string, text: string) => {
      mkdirSync(join(h.optchatHome, "profiles", name), { recursive: true });
      writeFileSync(join(h.optchatHome, "profiles", name, "AGENTS.md"), text, { mode: 0o600 });
    };
    const original = "# Emmet\n\nRole.\n\n<!-- bot-dm:begin v1 -->\n## Bot-to-bot DMs\n<!-- bot-dm:end -->\n";
    prof("emmet", original);
    prof("plain", "# Plain\n");
    mkdirSync(join(h.optchatHome, "profiles", "empty"), { recursive: true });
    const done = stripProfiles(h.optchatHome, new Date("2026-11-13T00:00:00Z"));
    assert.deepEqual(done.map((d) => d.profile), ["emmet"]);
    const file = join(h.optchatHome, "profiles", "emmet", "AGENTS.md");
    assert.equal(readFileSync(file, "utf8"), "# Emmet\n\nRole.\n");
    assert.equal(readFileSync(done[0]!.backup, "utf8"), original);
    assert.match(done[0]!.backup, /AGENTS\.md\.bak-bot-dm-2026-11-13T00-00-00-000Z$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(h.optchatHome, "profiles", "plain", "AGENTS.md"), "utf8"), "# Plain\n");
    assert.deepEqual(stripProfiles(h.optchatHome), [], "idempotent");
    assert.deepEqual(stripProfiles(join(h.base, "nowhere")), []);
  } finally {
    h.done();
  }
});

test("create: template + purpose + chosen model, AGENTS.md without any bot-dm block; no host steps left", async () => {
  const h = tempHost();
  try {
    const files = new BotFiles({ root: h.root, optchatHome: h.optchatHome });
    const out = await files.create({
      name: "Margot",
      agentsMd: "",
      template: "writer",
      purpose: "Drafts my posts",
      chat: { provider: "optchat/openrouter/z-ai/glm-5.3", thinkingOptionId: "low" },
    });
    assert.deepEqual(out, { botId: "margot", missing: [] });
    assert.deepEqual(CREATE_MISSING_STEPS, []);
    const md = readFileSync(join(h.optchatHome, "profiles", "margot", "AGENTS.md"), "utf8");
    assert.match(md, /^# Margot\n\nWhat Margot is for: Drafts my posts\n\nMargot drafts and edits/);
    assert.doesNotMatch(md, /bot-dm/);
    const meta = JSON.parse(readFileSync(join(h.root, "margot", ".bot.json"), "utf8"));
    assert.deepEqual(meta.chat, { provider: "optchat/openrouter/z-ai/glm-5.3", thinkingOptionId: "low" });
    assert.deepEqual(await botChatConfig(join(h.root, "margot")), { provider: "optchat/openrouter/z-ai/glm-5.3", thinkingOptionId: "low" });
    // Own AGENTS.md text wins over the template; the block is still added.
    await files.create({ name: "Own", agentsMd: "# Own\nMine.", template: "coder" });
    const own = readFileSync(join(h.optchatHome, "profiles", "own", "AGENTS.md"), "utf8");
    assert.match(own, /^# Own\nMine.\n$/);
    await assert.rejects(files.create({ name: "Bad", agentsMd: "", chat: { provider: "claude/opus" } }), ManageError);
  } finally {
    h.done();
  }
});

test("delete: folder and profile move to .trash (nothing erased); groups block it; home entry forgotten", async () => {
  const h = tempHost();
  try {
    const files = new BotFiles({ root: h.root, optchatHome: h.optchatHome });
    await files.create({ name: "Gone Soon", agentsMd: "" });
    await assert.rejects(files.remove("gone-soon", ["Launch"]), /Remove gone-soon from Launch first/);
    const { trash } = await files.remove("gone-soon", [], new Date("2026-10-26T01:02:03.000Z"));
    assert.equal(trash, join(h.root, ".trash", "gone-soon-2026-10-26T01-02-03-000Z"));
    assert.equal(existsSync(join(h.root, "gone-soon")), false);
    assert.equal(existsSync(join(h.optchatHome, "profiles", "gone-soon")), false);
    assert.ok(existsSync(join(trash, "bot", ".optchat-profile")));
    assert.ok(existsSync(join(trash, "profile", "AGENTS.md")));
    await assert.rejects(files.remove("gone-soon"), /Unknown bot/);

    const home = new HomeStateFile(h.root);
    await home.pin(null, "bot:gone-soon", true);
    await home.pin(null, "bot:other", true);
    const after = await home.forget(null, "bot:gone-soon");
    assert.deepEqual(after.pins, ["bot:other"]);
  } finally {
    h.done();
  }
});
