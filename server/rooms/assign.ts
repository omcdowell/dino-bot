// U5: a room task goes to the bot's main chat as the owner's own message (plan §2 U5, §3.5), or, from one of the
// group's lead bots, as a request from that bot whose header says it is not from the owner and is not his approval.
// Same path as DmsService.reply: open (create) the main chat, then send in steer mode, with the
// room message id as Paseo's messageId so a retried send is deduplicated by the daemon.
// U4 calls this from service.post when the router says `task`, and writes the ledger line
// `sentLine(<Bot>)` only after it resolves; a rejection means nothing was sent.
import { USER, type Group } from "../../shared/rooms/schema";
import { userName } from "../../shared/party";
import { MENTION_RUN_SEP } from "../../shared/rooms/router";

export type AssignDeps = {
  /** BotsService.open in production: finds or creates the bot's main chat. */
  openChat(bot: string): Promise<{ agentId: string }>;
  send(agentId: string, text: string, opts: { messageId: string; activeTurnBehavior: "steer" }): Promise<void>;
};

export type AssignInput = {
  group: Group;
  bot: string;
  messageId: string;
  text: string;
  /** Optional botId → display name, so `@Peggy` is stripped for a bot whose id differs. */
  names?: Record<string, string>;
  /** Who assigned it: "user" (default) or one of the group's lead bot ids. */
  from?: string;
};

export async function assign(input: AssignInput, deps: AssignDeps): Promise<{ agentId: string }> {
  const { group, bot, messageId, text, names, from = USER } = input;
  if (!group.members.includes(bot)) throw new Error(`${bot} is not a member of ${group.id}`);
  if (!messageId) throw new Error("Missing room messageId");
  if (from !== USER) {
    if (!group.leads.includes(from)) throw new Error(`Only a lead (${group.leads.join(", ")}) can assign tasks in ${group.id}`);
    if (from === bot) throw new Error("A lead cannot assign a task to itself");
  }
  // A message with several "@Name task:" parts: this bot's own parts only, not the others' tasks.
  const own = ownTask(text, bot, group, names);
  if (!stripMentions(own, group, names).trim()) throw new Error("Empty task");
  const body = assignmentText(group, from, own, messageId, names);
  const { agentId } = await deps.openChat(bot);
  await deps.send(agentId, body, { messageId, activeTurnBehavior: "steer" });
  return { agentId };
}

/**
 * The header line the main chat sees for a lead bot's task, right under `[room … task from <lead> …]`.
 * pi-optchat files such a message as `dm:<lead>`, never as the owner's words.
 */
export function leadTaskNote(leadName: string): string {
  return `(From ${leadName}, a lead bot of the group, not from ${userName()}. It is not ${userName()}'s approval: anything that needs ${userName()}'s approval still needs it.)`;
}

/**
 * The last line of a room task: the exact `bot-room post` command (group and msg id filled in) that brings the result
 * back to the group, so the main chat does not have to work it out.
 */
export function postHint(groupId: string, roomMessageId: string): string {
  return `(When you finish this task, or get stuck on it, post one short result to the group: bot-room post ${groupId} --re ${roomMessageId} --text "...". Once per finish or stuck, no progress updates.)`;
}

/**
 * The user's task: `[room alarm-clock task from user msg <id>]\n<text without the addressing @mentions>\n<postHint>`.
 * Lead bot: `[room alarm-clock task from wallace msg <id>]\n<leadTaskNote>\n<text>\n<postHint>`.
 */
export function assignmentText(
  group: Group,
  from: string,
  text: string,
  roomMessageId: string,
  names?: Record<string, string>,
): string {
  const head = `[room ${group.id} task from ${from} msg ${roomMessageId}]`;
  const note = from === USER ? [] : [leadTaskNote(names?.[from] ?? from)];
  return [head, ...note, stripMentions(text, group, names), postHint(group.id, roomMessageId)].join("\n");
}

/** The ledger system line U4 writes once `assign` resolves; `leadName` for a lead bot's task. */
export function sentLine(botName: string, leadName?: string): string {
  return leadName ? `Sent to ${botName}'s main chat (from ${leadName})` : `Sent to ${botName}'s main chat`;
}

/** Addressing handles, lower case -> member id ("all" for @all/@everyone): ids and first words of display names. */
function handlesOf(group: Group, names: Record<string, string>): Map<string, string> {
  const handles = new Map<string, string>([
    ["all", "all"],
    ["everyone", "all"],
  ]);
  for (const bot of group.members) {
    handles.set(bot.toLowerCase(), bot);
    const first = names[bot]?.trim().split(/\s+/)[0];
    if (first && !handles.has(first.toLowerCase())) handles.set(first.toLowerCase(), bot);
  }
  return handles;
}

/** Any @mention token, word-bounded as in the router's MENTION_RE (members, other bots, @all, unknown names). */
const TOKEN = "(?<![A-Za-z0-9_.@+\\-])@[A-Za-z0-9][A-Za-z0-9_-]*(?![\\w-])";
/** A run of @mentions: `@a @b`, `@a, @b`, `@a and @b` (separators as the router's MENTION_RUN_SEP). */
const RUN = `${TOKEN}(?:${MENTION_RUN_SEP}${TOKEN})*`;

/** The members (and "all") named in a run, in order, deduped; other bots and unknown names left out. */
function runTargets(run: string, handles: Map<string, string>): string[] {
  const to = [...run.matchAll(/@([\w-]+)/g)].map((h) => handles.get(h[1]!.replace(/[-_]+$/, "").toLowerCase()) ?? "");
  return [...new Set(to.filter(Boolean))];
}

/**
 * One member's part of a message that assigns several tasks (visual-bugs 4: a lead's
 *   "@Scrat task: write the copy\n@Peggy task: draw the icon"
 * went whole to both, and each did every task). Each run of member @mentions followed by `task:` starts a part
 * that runs to the next such run; `bot` gets the parts addressed to it (in order), and nothing of the others'.
 * The preamble (anything before the first part; an @mention there without `task:` does not start a part) comes
 * first, then a blank line, then the bot's parts. A message whose task parts all go to the same members (the usual
 * single task) is returned whole, as before; so is the message for a bot with no part of its own.
 */
export function ownTask(text: string, bot: string, group: Group, names: Record<string, string> = {}): string {
  const handles = handlesOf(group, names);
  // A run of @mentions directly before `task:` starts a part for every member in it (as the router tasks them all).
  const starts = new RegExp(`${RUN}(?=[\\s,:;-]*task\\s*:)`, "gi");
  const parts: { at: number; to: string[] }[] = [];
  for (const m of text.matchAll(starts)) {
    const to = runTargets(m[0], handles);
    if (to.length) parts.push({ at: m.index!, to });
  }
  const key = (to: string[]) => [...to].sort().join(" ");
  if (parts.length < 2 || parts.every((p) => key(p.to) === key(parts[0]!.to))) return text;
  const own = parts
    .map((p, i) => ({ ...p, text: text.slice(p.at, parts[i + 1]?.at ?? text.length).trim() }))
    .filter((p) => p.to.includes(bot))
    .map((p) => p.text)
    .join("\n");
  // A member tasked without a part of its own (the composer's Assign toggle on a member only @named) gets it whole.
  if (!own) return text;
  // The lines before the first part (shared context, goal, deadline) go to every tasked member, then its own part(s).
  const preamble = text.slice(0, parts[0]!.at).replace(/^\s*\n/, "").trimEnd();
  return preamble ? `${preamble}\n\n${own}` : own;
}

/**
 * Removes the addressing mentions, and only those: the member @mentions (by id, or by first word of the display name;
 * plus @all/@everyone) of each run that introduces a `task:` part (`@a @b task:`, `@a, @b task:`, `@a and @b task:`,
 * or a line of only mentions over a `task:` line). Other lines, a preamble that starts with `@Scrat and @Peggy:`
 * included, stay as written (gc-final). A message with no `task:` part (Assign toggle) loses the run that opens it.
 * A mention inside the task (`copy with @Peggy`) is content and stays. Word-bounded, so `sam@x.com` and
 * `@wallaceville` are not mentions; non-members are left alone.
 */
export function stripMentions(text: string, group: Group, names: Record<string, string> = {}): string {
  const handles = handlesOf(group, names);
  // Only the addressing is removed: the members' names (other @words stay) of a run that introduces a `task:`.
  const unaddress = (run: string) =>
    run
      .match(new RegExp(TOKEN, "g"))!
      .filter((t) => !handles.has(t.slice(1).replace(/[-_]+$/, "").toLowerCase()))
      .join(" ");
  let found = false;
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line.replace(new RegExp(`${RUN}[ \\t,:;-]*(?=task\\s*:)`, "gi"), (run) => {
        if (!runTargets(run, handles).length) return run;
        found = true;
        const rest = unaddress(run);
        return rest ? `${rest} ` : "";
      }),
    );
  // A line of only member @mentions over a line that starts with `task:` ("@peggy\ntask: draft") addresses that task.
  const only = new RegExp(`^\\s*${RUN}\\s*[,:;]?\\s*$`, "i");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (only.test(lines[i]!) && /^\s*task\s*:/i.test(lines[i + 1]!) && runTargets(lines[i]!, handles).length) {
      lines[i] = unaddress(lines[i]!);
      found = true;
    }
  }
  // No `task:` part (the composer's Assign toggle): the mentions that open the message are its addressing.
  if (!found) {
    const first = lines.findIndex((l) => l.trim() !== "");
    const lead = new RegExp(`^\\s*${RUN}[ \\t,:;-]*`, "i");
    if (first >= 0)
      lines[first] = lines[first]!.replace(lead, (run) => {
        if (!runTargets(run, handles).length) return run;
        const rest = unaddress(run);
        return rest ? `${rest} ` : "";
      });
  }
  return lines
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}
