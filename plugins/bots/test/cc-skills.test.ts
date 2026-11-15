/** Claude Code bots: the skills in their prompt (server/cc/skills.ts), as pi lists them for a pi bot. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CcEngine } from "../server/cc/engine";
import { ccBotSkills, formatCcSkills, frontMatter, pluginSkillsDirFor } from "../server/cc/skills";

const TMP = mkdtempSync(join(tmpdir(), "cc-skills-"));
const skill = (dir: string, name: string, front: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\n${front}\n---\n\n# ${name}\n`);
};

/** A host: plugin skills, a bot with its own skill, the user's global skills, an OptChat home. */
function host(name: string) {
  const root = join(TMP, name);
  const plugin = join(root, "plugin", "skills");
  const bot = join(root, "bots", "kit");
  const home = join(root, "home");
  const optchat = join(root, "optchat");
  const profile = join(optchat, "profiles", "kit");
  const pi = join(home, ".pi", "agent");
  skill(plugin, "workers", "name: workers\ndescription: Run herdr workers.");
  skill(plugin, "herdr", 'name: herdr\ndescription: "Control Herdr: panes & tabs."');
  skill(plugin, "tdd", "name: tdd\ndescription: Red-green-refactor.");
  skill(join(bot, ".agents", "skills"), "my-report", "name: my-report\ndescription: >\n  Weekly report,\n  as a script.");
  skill(join(home, ".agents", "skills"), "handoff", "name: handoff\ndescription: Write a handoff.");
  skill(join(home, ".agents", "skills"), "grill-me", "name: grill-me\ndescription: Not for bots.");
  skill(join(home, ".agents", "skills"), "herdr", "name: herdr\ndescription: The user's own herdr copy.");
  skill(join(pi, "skills"), "fleet-ops", "name: fleet-ops\ndescription: Fleet chores.");
  mkdirSync(profile, { recursive: true });
  return { root, plugin, bot, home, optchat, profile, pi };
}

after(() => {});

describe("cc bot skills", () => {
  it("front matter: plain, quoted and folded values", () => {
    assert.deepEqual(frontMatter('---\nname: a\ndescription: "x: y"\n---\nbody'), { name: "a", description: "x: y" });
    assert.deepEqual(frontMatter("---\nname: a\ndescription: >\n  one\n  two\nother: 'it''s'\n---\n"), { name: "a", description: "one two", other: "it's" });
    assert.deepEqual(frontMatter("no front matter"), {});
  });

  it("plugin skills, the bot's own, and only the globals the shared list names; first name wins; hide drops", () => {
    const h = host("h1");
    writeFileSync(join(h.optchat, "skills.json"), JSON.stringify({ global: ["herdr", "handoff", "fleet-ops"], hide: [] }));
    const skills = ccBotSkills({ pluginSkillsDir: h.plugin, botDir: h.bot, profileDir: h.profile, optchatHome: h.optchat, piAgentDir: h.pi, home: h.home });
    assert.deepEqual(
      skills.map((s) => s.name),
      ["fleet-ops", "handoff", "herdr", "my-report", "tdd", "workers"],
    );
    // herdr is the plugin's copy, not the user's.
    assert.equal(skills.find((s) => s.name === "herdr")!.path, join(h.plugin, "herdr", "SKILL.md"));
    assert.equal(skills.find((s) => s.name === "my-report")!.description, "Weekly report, as a script.");
    // The profile's own list overrides the shared one, key by key.
    writeFileSync(join(h.profile, "config.json"), JSON.stringify({ skills: { hide: ["tdd"] } }));
    const hidden = ccBotSkills({ pluginSkillsDir: h.plugin, botDir: h.bot, profileDir: h.profile, optchatHome: h.optchat, piAgentDir: h.pi, home: h.home });
    assert.deepEqual(
      hidden.map((s) => s.name),
      ["fleet-ops", "handoff", "herdr", "my-report", "workers"],
    );
  });

  it("formats pi's <available_skills> block for the Read tool; nothing without skills", () => {
    const text = formatCcSkills([{ name: "herdr", description: "Panes & <tabs>", path: "/s/herdr/SKILL.md" }]);
    assert.match(text, /Use the Read tool to load a skill's file/);
    assert.match(text, /<available_skills>\n  <skill>\n    <name>herdr<\/name>\n    <description>Panes &amp; &lt;tabs&gt;<\/description>\n    <location>\/s\/herdr\/SKILL.md<\/location>\n  <\/skill>\n<\/available_skills>/);
    assert.equal(formatCcSkills([]), "");
  });

  it("the plugin's skills folder sits next to claude-code/", () => {
    const h = host("h2");
    mkdirSync(join(h.root, "plugin", "claude-code"), { recursive: true });
    assert.equal(pluginSkillsDirFor(join(h.root, "plugin", "claude-code")), h.plugin);
    assert.equal(pluginSkillsDirFor(join(h.root, "nowhere", "claude-code")), undefined);
  });

  it("a Claude Code bot's system prompt lists its skills before the host section and AGENTS.md", async () => {
    const h = host("h3");
    writeFileSync(join(h.profile, "AGENTS.md"), "# Kit\n\nYou are Kit.\n");
    const botPrompt = join(h.root, "kit.md");
    writeFileSync(botPrompt, "# DinoBot bot\n\nHost rules.");
    const e = await CcEngine.open("kit", h.profile, {
      env: { HOME: h.home, PI_CODING_AGENT_DIR: h.pi, OPTCHAT_BOT_PROMPT: botPrompt },
      botDir: h.bot,
      skillsDir: h.plugin,
    });
    try {
      const p = e.systemPrompt();
      const at = (s: string) => p.indexOf(s);
      assert.ok(at("<name>workers</name>") > 0, "workers skill listed");
      assert.ok(at("<name>my-report</name>") > 0, "the bot's own skill listed");
      assert.equal(at("<name>handoff</name>"), -1, "a global skill the shared list does not name stays out");
      assert.ok(at("<available_skills>") < at("# DinoBot bot"));
      assert.ok(at("# DinoBot bot") < at("You are Kit."));
      assert.equal(p, e.systemPrompt(), "byte-identical turn to turn");
    } finally {
      await e.close();
    }
  });
});
