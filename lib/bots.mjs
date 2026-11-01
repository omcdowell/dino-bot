// The suggested (never required) first bot: a coordinator from the plugin's AGENTS.md templates.
// Writes the same files as the plugin's BotFiles.create (rel-app), so the app shows it like any
// bot made on the phone. Removing it later moves it to ~/bots/.trash, as Delete bot does.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic, writeJson } from "./util.mjs";

export const STARTER = { name: "Juniper", template: "coordinator" };

const FALLBACK_ROLE =
  "{name} is the coordinator. Keep a short list of what is in progress and who owns it. " +
  "Break bigger asks into small tasks and hand them to the bot that fits best (bot-dm). " +
  "Check back on open tasks and tell me plainly what is done, what is blocked and what needs my decision.";

export function botIdFor(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function agentsMdBody(app, name, template) {
  const file = join(app, "bots", "shared", "templates.ts");
  if (existsSync(file)) {
    try {
      const { agentsMdFor } = await import(pathToFileURL(file).href);
      return agentsMdFor({ name, template });
    } catch {
      /* fall through */
    }
  }
  return `# ${name}\n\n${FALLBACK_ROLE.replaceAll("{name}", name)}\n`;
}

/** The plugin's bot-dm block, with the sync tool's markers so a later sync replaces it. */
function botDmBlock(app) {
  const snippet = join(app, "bots", "docs", "bot-dm-agents-snippet.md");
  if (!existsSync(snippet)) return "";
  const sync = join(app, "bots", "bin", "bot-dm-snippet-sync");
  const version = existsSync(sync) ? (/VERSION = (\d+)/.exec(readFileSync(sync, "utf8"))?.[1] ?? "1") : "1";
  return `\n<!-- bot-dm:begin v${version} -->\n${readFileSync(snippet, "utf8").trimEnd()}\n<!-- bot-dm:end -->\n`;
}

/**
 * Creates the starter bot unless a bot folder or profile of that id exists already (then it is
 * reused, so a re-run of setup is harmless). `models` is resolveModels() output.
 */
export async function createStarterBot(L, { name = STARTER.name, template = STARTER.template, models, subscription }) {
  const botId = botIdFor(name);
  const dir = join(L.botsRoot, botId);
  const profile = join(L.optchatHome, "profiles", botId);
  if (existsSync(join(dir, ".optchat-profile"))) return { botId, created: false };
  const body = await agentsMdBody(L.app, name, template);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(profile, "AGENTS.md"), body + botDmBlock(L.app), 0o600);
  if (models) {
    writeJson(
      join(profile, "config.json"),
      {
        subscription,
        compactor: models.compaction,
        subagent: models.worker,
        setup: true, // the host default, not the user's own pick: "Choose models" may move it
      },
      0o600,
    );
  }
  mkdirSync(join(dir, "dm"), { recursive: true, mode: 0o700 });
  const chat = models ? { provider: `optchat/${models.main.provider}/${models.main.model}`, thinkingOptionId: models.main.thinking, setup: true } : undefined;
  writeFileAtomic(join(dir, ".bot.json"), `${JSON.stringify({ name, order: 10, icon: "Bot", ...(chat ? { chat } : {}) })}\n`, 0o600);
  writeFileAtomic(join(dir, ".optchat-profile"), `${botId}\n`, 0o600); // last: this makes it a bot
  return { botId, created: true };
}

/** "Skip" after the fact: nothing is erased, the files move to ~/bots/.trash/<id>-<time>/. */
export function trashBot(L, botId, now = new Date()) {
  const dir = join(L.botsRoot, botId);
  const profile = join(L.optchatHome, "profiles", botId);
  const trash = join(L.botsRoot, ".trash", `${botId}-${now.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  if (existsSync(profile)) renameSync(profile, join(trash, "profile"));
  if (existsSync(dir)) renameSync(dir, join(trash, "bot"));
  return trash;
}
