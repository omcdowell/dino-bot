import { randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BOT_NAME_RE,
  WORKER_NAME_RE,
  DM_MAX_BODY,
  DM_MAX_SUBJECT,
  DM_SCHEMA_VERSION,
  type DmMessage,
  type DmStatus,
} from "../shared/dm-schema";
import { DMS_ORIGIN, USER, replyText, type DmBotSummary, type DmThreadSummary, type DmView } from "../shared/dm-rpc";
import { isUserParty } from "../shared/party";
import { appendLedgerRecord } from "./ledger-write";
import { LedgerCache } from "./ledger";

/** The slice of the Paseo SDK replies need, so tests can pass a fake. */
export interface DmsPaseo {
  agents: {
    ref(id: string): {
      send(text: string, options?: { messageId?: string; activeTurnBehavior?: "interrupt" | "steer" }): Promise<void>;
    };
  };
}

export interface DmsOptions {
  /** Bots root, e.g. ~/bots. */
  root: string;
  /** Finds (or creates) the bot's chat; BotsService.open in production. Gets the handler's Paseo connection. */
  openChat(botId: string, paseo: DmsPaseo): Promise<{ agentId: string }>;
  /**
   * Where bot-dm keeps herdr workers' outboxes (`<workersRoot>/<name>/outbox.jsonl`), so worker
   * reports show their delivery status. Default `$XDG_STATE_HOME/bot-dm/workers`, as bot-dm writes.
   */
  workersRoot?: string;
  cache?: LedgerCache;
  now?: () => number;
  newId?: () => string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID layout: 10 chars of ms time, 16 random, Crockford base32. Same as bot-dm. */
export function ulid(now = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  return time + Array.from(randomBytes(16), (b) => CROCKFORD[b % 32]).join("");
}

const ms = (ts: string) => Date.parse(ts);
const byTime = (a: DmMessage, b: DmMessage) => ms(a.ts) - ms(b.ts) || a.id.localeCompare(b.id);
const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim();

export function subjectOf(message: Pick<DmMessage, "subject" | "body">): string {
  const subject = message.subject.trim() || firstLine(message.body);
  return subject.length > DM_MAX_SUBJECT ? `${subject.slice(0, DM_MAX_SUBJECT - 1)}…` : subject;
}

export function defaultWorkersRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "bot-dm", "workers");
}

function assertBotId(botId: string) {
  if (!BOT_NAME_RE.test(botId) || isUserParty(botId)) throw new Error(`Not a bot id: ${botId}`);
}

/** Latest status per message id; on equal times the later line wins. */
export function latestStatuses(statuses: Iterable<DmStatus>): Map<string, DmStatus> {
  const latest = new Map<string, DmStatus>();
  for (const status of statuses) {
    const held = latest.get(status.id);
    if (!held || ms(status.ts) >= ms(held.ts)) latest.set(status.id, status);
  }
  return latest;
}

/** Groups one bot's views into thread summaries, newest activity first. */
export function summariseThreads(botId: string, views: DmView[]): DmThreadSummary[] {
  const groups = new Map<string, DmView[]>();
  for (const view of views) {
    const group = groups.get(view.thread);
    if (group) group.push(view);
    else groups.set(view.thread, [view]);
  }
  const threads: DmThreadSummary[] = [];
  for (const [thread, messages] of groups) {
    messages.sort(byTime);
    const root = messages.find((m) => m.id === thread) ?? messages[0]!;
    const last = messages[messages.length - 1]!;
    const parties: string[] = [];
    for (const m of messages) for (const p of [m.from, m.to]) if (p !== botId && !parties.includes(p)) parties.push(p);
    // A request is answered by a message from its addressee that points at it (the owner's notes do not count).
    const answered = (m: DmView) => messages.some((x) => x.re === m.id && x.from === m.to);
    threads.push({
      thread,
      subject: subjectOf(root),
      parties,
      kind: root.kind,
      count: messages.length,
      first_ts: messages[0]!.ts,
      last_ts: last.ts,
      last_from: last.from,
      last_status: last.status,
      max_hop: Math.max(...messages.map((m) => m.hop)),
      has_escalate: messages.some((m) => m.kind === "escalate"),
      awaiting_reply: messages.some((m) => m.expects_reply && !answered(m) && m.status !== "refused"),
      has_problem: messages.some((m) => m.status === "refused" || m.status === "failed"),
    });
  }
  return threads.sort((a, b) => ms(b.last_ts) - ms(a.last_ts));
}

export class DmsService {
  private readonly cache: LedgerCache;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: DmsOptions) {
    this.cache = options.cache ?? new LedgerCache();
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => ulid(this.now()));
  }

  private dmDir(botId: string) {
    return join(this.options.root, botId, "dm");
  }

  /** The dm dir whose outbox holds `sender`'s statuses: a bot's `dm/`, or a worker's state dir. */
  private senderDir(sender: string): string | null {
    if (WORKER_NAME_RE.test(sender)) {
      return join(this.options.workersRoot ?? defaultWorkersRoot(), sender.slice("worker:".length));
    }
    return BOT_NAME_RE.test(sender) && !isUserParty(sender) ? this.dmDir(sender) : null;
  }

  /** Folder ids under the root that hold a `dm/` directory. */
  async ledgerBots(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.options.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const bots: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !BOT_NAME_RE.test(entry.name)) continue;
      try {
        if ((await stat(this.dmDir(entry.name))).isDirectory()) bots.push(entry.name);
      } catch {
        // no ledger
      }
    }
    return bots.sort();
  }

  /** One bot's messages (inbox and outbox, deduplicated by id) with skip counts. */
  private async ownMessages(botId: string) {
    const dir = this.dmDir(botId);
    const [inbox, outbox] = await Promise.all([this.cache.read(dir, "inbox"), this.cache.read(dir, "outbox")]);
    const byId = new Map<string, DmMessage>();
    for (const m of [...inbox.messages, ...outbox.messages]) if (!byId.has(m.id)) byId.set(m.id, m);
    return {
      messages: [...byId.values()].sort(byTime),
      ownStatuses: outbox.statuses,
      skipped: {
        invalid: inbox.invalid + outbox.invalid,
        unknown: inbox.unknown + outbox.unknown,
        truncated: inbox.truncated || outbox.truncated,
      },
    };
  }

  /** The bot's messages as views, with statuses joined from every sender's outbox. */
  async views(botId: string) {
    assertBotId(botId);
    const own = await this.ownMessages(botId);
    const statuses: DmStatus[] = [...own.ownStatuses];
    const senders = new Set(own.messages.map((m) => m.from).filter((p) => p !== botId));
    for (const sender of senders) {
      const dir = this.senderDir(sender);
      if (dir) statuses.push(...(await this.cache.read(dir, "outbox")).statuses);
    }
    const status = latestStatuses(statuses);
    const views: DmView[] = own.messages.map((m) => ({
      ...m,
      direction: m.from === botId ? "out" : "in",
      status: status.get(m.id)?.status ?? null,
      status_detail: status.get(m.id)?.detail ?? null,
    }));
    return { views, skipped: own.skipped };
  }

  async summary(): Promise<DmBotSummary[]> {
    const out: DmBotSummary[] = [];
    for (const botId of await this.ledgerBots()) {
      const { messages } = await this.ownMessages(botId);
      if (!messages.length) continue;
      out.push({ botId, total: messages.length, last_ts: messages[messages.length - 1]!.ts });
    }
    return out;
  }

  /** When the bot last sent or received a DM (for the phone home's recency order). */
  async latestAt(botId: string): Promise<string | null> {
    assertBotId(botId);
    const { messages } = await this.ownMessages(botId);
    return messages.at(-1)?.ts ?? null;
  }

  /** The latest DM the bot sent (its outbox, by time), for the phone home's row preview. */
  async latestOutgoing(botId: string): Promise<{ ts: string; to: string; subject: string } | null> {
    assertBotId(botId);
    const { messages } = await this.ownMessages(botId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.from === botId) return { ts: m.ts, to: m.to, subject: subjectOf(m) };
    }
    return null;
  }

  async threads(botId: string) {
    const { views, skipped } = await this.views(botId);
    return { threads: summariseThreads(botId, views), skipped };
  }

  async thread(botId: string, ref: { threadId?: string; messageId?: string }) {
    const { views } = await this.views(botId);
    const threadId = ref.threadId ?? views.find((v) => v.id === ref.messageId)?.thread;
    const messages = threadId ? views.filter((v) => v.thread === threadId) : [];
    return { thread: summariseThreads(botId, messages)[0] ?? null, messages };
  }

  /**
   * Sends the owner's reply into the bot's chat as his own message, in steer mode (lands at the next
   * tool-call boundary, never cancels a turn), then records it in the bot's inbox so the thread shows it.
   * The reply id doubles as Paseo's messageId, so a retried send is deduplicated by the daemon.
   */
  async reply(botId: string, threadId: string, text: string, paseo: DmsPaseo) {
    assertBotId(botId);
    const body = text.trim();
    if (!body) throw new Error("Empty reply");
    if (body.length > DM_MAX_BODY) throw new Error(`Reply is ${body.length} characters; the limit is ${DM_MAX_BODY}.`);
    const { messages } = await this.thread(botId, { threadId });
    const last = messages[messages.length - 1];
    if (!last) throw new Error(`No DM thread ${threadId} for ${botId}`);

    const { agentId } = await this.options.openChat(botId, paseo);
    const id = this.newId();
    await paseo.agents.ref(agentId).send(replyText(threadId, body), { messageId: id, activeTurnBehavior: "steer" });

    const ts = new Date(this.now()).toISOString();
    const record: DmMessage = {
      v: DM_SCHEMA_VERSION,
      type: "message",
      id,
      ts,
      from: USER,
      to: botId,
      kind: "info",
      thread: threadId,
      re: last.id,
      // Hops count bot-to-bot steps (bot-dm caps them at 3); the owner's note does not add one.
      hop: last.hop,
      subject: subjectOf({ subject: "", body }),
      body,
      attachments: [],
      expects_reply: false,
      from_agent_id: null,
      to_agent_id: agentId,
      origin: DMS_ORIGIN,
    };
    let warning: string | null = null;
    try {
      await appendLedgerRecord(this.dmDir(botId), "inbox", record);
    } catch (error) {
      warning = `Sent, but not recorded in the ledger: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { id, agentId, recorded: warning === null, warning };
  }
}
