/**
 * Starter AGENTS.md templates for a new bot (release/app). Small on purpose: the user's own words
 * matter more than ours. Setup suggests a coordinator for the first bot but never requires one.
 * Pure; imports nothing, so the client and the server share it.
 */

export const TEMPLATE_IDS = ["coordinator", "researcher", "writer", "coder", "blank"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface BotTemplate {
  id: TemplateId;
  label: string;
  /** One line under the label in the picker. */
  blurb: string;
  /** The role paragraph; `{name}` is the bot's name. Empty for blank. */
  role: string;
}

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "coordinator",
    label: "Coordinator",
    blurb: "Keeps track of the big picture and hands work to your other bots.",
    role:
      "{name} is the coordinator. Keep a short list of what is in progress and who owns it. " +
      "Break bigger asks into small tasks and hand them to the bot that fits best (bot-dm). " +
      "Check back on open tasks and tell me plainly what is done, what is blocked and what needs my decision.",
  },
  {
    id: "researcher",
    label: "Researcher",
    blurb: "Looks things up and comes back with sources.",
    role:
      "{name} researches questions for me. Look for several sources, say how sure you are, and link what you used. " +
      "Lead with the answer in two or three lines, then the detail. Say so when the evidence is thin.",
  },
  {
    id: "writer",
    label: "Writer",
    blurb: "Drafts and edits text in your voice.",
    role:
      "{name} drafts and edits writing for me: notes, emails, posts and documents. " +
      "Use plain words and short sentences. Ask who it is for if that is not clear. Offer one draft, not five.",
  },
  {
    id: "coder",
    label: "Coder",
    blurb: "Works on code in a project folder.",
    role:
      "{name} works on code. Read the existing code before changing it, keep changes small, " +
      "and run the tests that cover what you touched. Commit on a branch, never on main, and never push without asking.",
  },
  {
    id: "blank",
    label: "Blank",
    blurb: "Start from nothing and write your own.",
    role: "",
  },
];

export function templateById(id: string | null | undefined): BotTemplate {
  return BOT_TEMPLATES.find((t) => t.id === id) ?? BOT_TEMPLATES[BOT_TEMPLATES.length - 1]!;
}

/**
 * The template the sheet starts on: a coordinator for the first bot (a suggestion, the user can
 * pick another), blank after that.
 */
export function suggestedTemplate(botCount: number): TemplateId {
  return botCount === 0 ? "coordinator" : "blank";
}

/** The AGENTS.md a new bot starts with: title, the user's one-line purpose, then the template's role. */
export function agentsMdFor(input: { name: string; template: string | null | undefined; purpose?: string | null }): string {
  const title = input.name.trim() || "New bot";
  const purpose = (input.purpose ?? "").trim().replace(/\s+/g, " ");
  const role = templateById(input.template).role.replaceAll("{name}", title);
  const parts = [`# ${title}`];
  if (purpose) parts.push(`What ${title} is for: ${purpose}`);
  if (role) parts.push(role);
  if (!purpose && !role) parts.push(`${title}: describe what this bot is for in one line.`);
  return `${parts.join("\n\n")}\n`;
}

/** The first message a new bot gets, so its chat opens with a hello that sums up its role. */
export const INTRO_PROMPT =
  "You were just created. Read your AGENTS.md, then introduce yourself to me in two or three short lines: who you are and how you can help. No tool calls needed.";
