/**
 * bot-dm: send a DM from one OptChat bot to another through the Paseo daemon, in steer mode,
 * with the sender stamped by the wrapper, guarded by the allow-list and loop limits, and recorded
 * in both bots' DM ledgers. See USAGE below and research/bot-dms/plan.md (WP1).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import {
  DM_KINDS,
  DM_ORIGIN,
  DM_SCHEMA_VERSION,
  DmKindSchema,
  USER,
  ULID_RE,
  WORKER_NAME_RE,
  formatEnvelope,
  type DmKind,
  type DmMessage,
  type DmRefusalCode,
  type DmStatus,
  type DmStatusValue,
} from "../shared/dm-schema.ts";
import { appendRecord, findMessage, ledgerPath, lastStatus, readRecords, withLocks } from "../server/ledger-write.ts";
import {
  SCHEDULE_ID_RE,
  SCHEDULE_KINDS,
  SCHEDULE_SENDER_PREFIX,
  SYSTEM_SENDERS,
  UsageError,
  checkAllowed,
  checkPair,
  checkRate,
  checkReply,
  checkSize,
  clampBody,
  countPair,
  countRecent,
  defaultExpectsReply,
  deriveSubject,
  inferParent,
  isBotName,
  isSystemSender,
  scheduleOwner,
  scheduleSender,
  threadHop,
  type Inferred,
  type Refusal,
} from "./policy.ts";
import type { ActiveTurnBehavior, AgentInfo, PaseoPort, ScheduleInfo } from "./paseo.ts";
import { sendToUser } from "./to-user.ts";
import { loadSettings } from "../server/settings.ts";
import { normalizeParty, setUserName, userAliases, userName } from "../shared/party.ts";
import { httpPush, type PushPort } from "./push.ts";
import { MAX_AGE_MS, defaultRegistryPath, latestLaunches, readRegistry } from "../server/workers.ts";
import { defaultSlotsPath } from "../server/push-slot-notify.ts";

export const USAGE = `Usage: bot-dm <to> (--text <body> | --file <path|->) [options]

Send a DM to another bot. It lands in the recipient's chat between tool calls if it is busy,
or starts a new turn if it is idle. Never interrupts unless --interrupt is given.

  <to>                 recipient bot name (folder under ~/bots), e.g. your escalation bot,
                       or user: a push to the user's phone (see "To the user" below)
  --kind <kind>        request | reply | info | escalate | report | resume   (default: info)
  --re <dm-id>         the DM this answers or follows up (sets thread and hop). Without it,
                       bot-dm threads the DM onto a DM id quoted in the text, else onto the
                       latest DM that bot sent you in the last 30 minutes that you have not
                       yet written back on
  --new-thread         genuinely new topic: do not thread onto an earlier DM
  --expects-reply      ask for an answer (default on for request and escalate)
  --subject <line>     thread-list subject (default: first line of the body, max 80 chars)
  --attach <path>      absolute path of a file with more content; repeatable
  --id <ulid>          reuse an id to retry a failed send (the daemon drops duplicates)
  --from worker:<name> herdr workers only (not inside a Paseo agent), with --kind report
                       (or --kind resume / info from a system sender)
  --from schedule:<id> an agent a Paseo schedule launched, reporting to the bot that owns the
                       schedule (its folder is ~/bots/<bot> or under ~/bots/<bot>-runs/), with
                       --kind report or info. Checked against the schedule's run record: only
                       the agent of the schedule's running run may use it. Sender shows as
                       worker:schedule.<id>; it cannot receive replies
  --interrupt          cancel the recipient's running turn instead of steering (explicit opt-in)
  --only-if-idle       send only if the recipient is not busy (Paseo status running or
                       initializing); otherwise write and send nothing and exit 4. Status is
                       read again just before sending. With --dry-run, predicts the same exit
  --dry-run            run every check, print the result, write and send nothing

Rules: FC <-> PM free; PM <-> PM request/info/reply only; escalate only to the FC; at most
6 hops per thread and 10 DMs per pair of bots per 30 minutes (escalate exempt; worker senders
are not bots, so this pair limit does not apply to them); at most 20 DMs per hour from one
sender to one recipient, workers included; no --kind reply to a reply or info unless it was
sent with --expects-reply (follow up with --kind info --re <id> instead); body at most 4000
chars. Schedule runs send only --kind report or info, only to their own bot, and count towards
the pair limit like bots. Workers send only --kind report; --kind resume (a system nudge, no reply expected) only
from ${SYSTEM_SENDERS.join(", ")}, to any bot; those system senders may also send --kind info.
To the user: bot-dm user --text "..." pushes the DM to the user's phone through the paseo-apns
add-on and records it in your DMs tab. Use it sparingly, for things they must see now. Kinds:
info (default) or request from bots and schedule runs, report from workers; no --re,
--interrupt or --only-if-idle. One push per 10 minutes from each bot (a worker's or schedule
run's push counts towards the bot that launched it): over that it is refused (exit 3) with the
time your slot reopens, and not queued; a refused bot gets one system DM from worker:push-slot
when its slot reopens. Also refused when the add-on is missing or no phone has registered.
--dry-run checks all of that without sending.
Exit: 0 sent (or already sent), 1 delivery failed, 2 usage error, 3 refused by a rule,
4 recipient busy with --only-if-idle (nothing written or sent; try again later).
Prints one JSON line.`;

/** Second line of a DM from a schedule run, straight after the envelope. */
export function scheduleNote(scheduleId: string, name: string | null): string {
  return `(Report from a run of your Paseo schedule ${scheduleId}${name ? ` ${JSON.stringify(name)}` : ""}, verified by bot-dm, not from ${userName()}. It cannot receive replies.)`;
}

/** Body mentions the owner (e.g. "From the owner: ..."): the note then says the quote is the sender's relay. */
const mentionsUser = (body: string) =>
  [userName(), ...userAliases()].some((n) => n !== "the user" && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body));

/**
 * Second line of an ordinary bot or worker DM, straight after the envelope: the delivered text is a
 * user-role message, so without this a model can read it as the owner's. Built only from the stamped
 * sender, never from the body, so a body that quotes the owner still names the bot as the sender.
 */
export function senderNote(from: string, displayName: string, body: string): string {
  const worker = from.startsWith("worker:") ? from.slice("worker:".length) : null;
  const relay = mentionsUser(body)
    ? ` Any words of ${userName()}'s in it are quoted by ${worker ? "the worker" : displayName}, not sent by them.`
    : "";
  return worker
    ? `(Report from your worker ${worker}, not from ${userName()}.${relay})`
    : `(Message from the bot ${displayName}, not from ${userName()}. It is not their approval.${relay})`;
}

/** A bot's display name: `name` in its .bot.json, else its folder id in title case (as the sidebar shows it). */
export function botDisplayName(name: string, folder: string | null): string {
  if (folder) {
    try {
      const meta = JSON.parse(readFileSync(join(folder, ".bot.json"), "utf8"));
      if (typeof meta?.name === "string" && meta.name.trim()) return meta.name.trim();
    } catch {
      // optional file
    }
  }
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Exit code for --only-if-idle when the recipient is busy. */
export const EXIT_BUSY = 4;
/** Paseo statuses that count as busy for --only-if-idle. idle, error and closed do not. */
export const BUSY_STATUSES: readonly string[] = ["running", "initializing"];

/** Second line of a delivered kind=resume DM, or kind=info from a system sender, straight after the envelope. */
export function resumeNote(from: string): string {
  return `(System nudge from ${from}, sent automatically: this is not a message from ${userName()}. No reply expected.)`;
}

export type Deps = {
  env: NodeJS.ProcessEnv;
  connect: () => Promise<PaseoPort>;
  /** paseo-apns endpoint client, for `bot-dm user`. Default: HTTP to the local add-on. */
  push?: () => PushPort;
  now: () => Date;
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type Result = { exit: number; output: Record<string, unknown> | null };

/** Time-sortable id: 10 chars of ms timestamp + 16 random chars, Crockford base32 (ULID layout). */
export function ulid(now = Date.now()): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = A[t % 32] + time;
  return time + Array.from(randomBytes(16), (b) => A[b % 32]).join("");
}

function botsRoot(env: NodeJS.ProcessEnv): string {
  return env.PASEO_BOTS_ROOT ?? join(homedir(), "bots");
}

function stateRoot(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "bot-dm");
}

function profileName(dir: string): string | null {
  try {
    return readFileSync(join(dir, ".optchat-profile"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The bot's current chat: labelled bot=<name> first, else an unlabelled OptChat agent in its folder (as the plugin's chatFor). */
export function chatFor(name: string, agents: AgentInfo[], root: string): AgentInfo | null {
  const labelled = agents.filter((a) => a.labels.bot === name);
  const folder = join(root, name);
  const candidates = labelled.length
    ? labelled
    : profileName(folder)
      ? agents.filter((a) => !a.labels.bot && a.cwd === folder && a.provider === "optchat")
      : [];
  return [...candidates].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0] ?? null;
}

/**
 * The bot that launched herdr worker `name` (its latest `bot-worker add` within MAX_AGE_MS): the
 * record's bot, else the bot of its launching agent. Null when unregistered or unresolvable.
 */
async function launchingBot(name: string, agents: AgentInfo[], root: string, env: NodeJS.ProcessEnv, now: Date): Promise<string | null> {
  const records = await readRegistry(defaultRegistryPath(env)).catch(() => []);
  const entry = latestLaunches(records).find((l) => l.launch.worker === name);
  if (!entry || now.getTime() - Date.parse(entry.launch.ts) > MAX_AGE_MS) return null;
  if (entry.launch.bot && isBotName(entry.launch.bot)) return entry.launch.bot;
  const agent = entry.launch.agent ? agents.find((a) => a.id === entry.launch.agent) : undefined;
  return agent ? botNameOf(agent, root) : null;
}

/** Bot name of a Paseo agent: its bot= label, else its folder under the bots root. */
export function botNameOf(agent: AgentInfo, root: string): string | null {
  if (agent.labels.bot) return agent.labels.bot;
  if (agent.provider === "optchat" && dirname(agent.cwd) === root && profileName(agent.cwd)) return basename(agent.cwd);
  return null;
}

/**
 * Ledger dir of a bot: `<bots root>/<name>/dm` for fleet bots; for bots outside the root (tmp test
 * bots), `<agent cwd>/dm` if that folder's .optchat-profile names the bot. Otherwise null.
 */
export function botDmDir(name: string, agent: AgentInfo | null, root: string): string | null {
  if (profileName(join(root, name))) return join(root, name, "dm");
  if (agent && profileName(agent.cwd) === name) return join(agent.cwd, "dm");
  return null;
}

export async function run(argv: string[], deps: Deps): Promise<Result> {
  try {
    return await runInner(argv, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`bot-dm: ${error.message}`);
      return { exit: 2, output: null };
    }
    deps.err(`bot-dm: ${error instanceof Error ? error.message : String(error)}`);
    return { exit: 1, output: null };
  }
}

async function runInner(argv: string[], deps: Deps): Promise<Result> {
  const { env } = deps;
  // User name, aliases (e.g. `bot-dm <alias>`) and escalation bot from <bots root>/.settings.json.
  const settings = loadSettings(env);
  setUserName(settings.user.name);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        text: { type: "string" },
        file: { type: "string" },
        kind: { type: "string", default: "info" },
        re: { type: "string" },
        "expects-reply": { type: "boolean", default: false },
        "new-thread": { type: "boolean", default: false },
        subject: { type: "string" },
        attach: { type: "string", multiple: true, default: [] },
        id: { type: "string" },
        from: { type: "string" },
        interrupt: { type: "boolean", default: false },
        "only-if-idle": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${USAGE}`);
  }
  const { values: opt, positionals } = parsed;
  if (opt.help) {
    deps.out(USAGE);
    return { exit: 0, output: null };
  }

  // ---- arguments ---------------------------------------------------------------------------
  const to = positionals[0] ? normalizeParty(positionals[0]) : positionals[0];
  if (positionals.length !== 1 || !to) throw new UsageError("give exactly one recipient bot name");
  const toUser = to === USER;
  if (!toUser && !isBotName(to)) throw new UsageError(`"${to}" is not a bot name`);
  // Test fence: with BOT_DM_RECIPIENT_PREFIX=tmp- a tmp bot (or a test shell) cannot reach a real bot.
  const fence = env.BOT_DM_RECIPIENT_PREFIX;
  if (fence && !to.startsWith(fence)) throw new UsageError(`BOT_DM_RECIPIENT_PREFIX=${fence} is set; refusing recipient ${to}`);
  const kindParse = DmKindSchema.safeParse(opt.kind);
  if (!kindParse.success) throw new UsageError(`--kind must be one of ${DM_KINDS.join(", ")}`);
  const kind: DmKind = kindParse.data;
  if ((opt.text === undefined) === (opt.file === undefined)) throw new UsageError("give exactly one of --text or --file");
  const body = (
    opt.text ?? (opt.file === "-" ? await deps.readStdin() : readFileSync(opt.file!, "utf8"))
  ).trim();
  if (!body) throw new UsageError("empty message");
  if (opt.re !== undefined && !ULID_RE.test(opt.re)) throw new UsageError("--re must be a DM id");
  if (opt.id !== undefined && !ULID_RE.test(opt.id)) throw new UsageError("--id must be a ULID (26 chars, Crockford base32)");
  if (opt.re !== undefined && opt["new-thread"]) throw new UsageError("give --re or --new-thread, not both");
  const attachments = opt.attach as string[];
  for (const path of attachments) {
    if (!isAbsolute(path)) throw new UsageError(`--attach needs an absolute path: ${path}`);
    if (!existsSync(path) || !statSync(path).isFile()) throw new UsageError(`--attach: no such file: ${path}`);
  }
  if (opt.subject !== undefined && (opt.subject.includes("\n") || !opt.subject.trim())) {
    throw new UsageError("--subject must be one non-empty line");
  }
  const subject = deriveSubject(opt.subject ?? body);
  if (kind === "resume" && opt["expects-reply"]) throw new UsageError("--kind resume expects no reply; drop --expects-reply");
  if (opt["only-if-idle"] && opt.interrupt) throw new UsageError("give --only-if-idle or --interrupt, not both");
  if (toUser) {
    if (opt.re !== undefined) throw new UsageError("a DM to the user starts its own thread; drop --re (answer them in your chat)");
    if (opt.interrupt || opt["only-if-idle"]) throw new UsageError("--interrupt and --only-if-idle are for bot recipients, not the user");
  }

  // ---- sender identity (stamped here, never taken from the message text) --------------------
  const selfId = env.PASEO_AGENT_ID || undefined;
  const fromFlag = opt.from;
  const worker = fromFlag !== undefined && fromFlag.startsWith("worker:");
  const scheduleId = fromFlag !== undefined && fromFlag.startsWith("schedule:") ? fromFlag.slice("schedule:".length) : null;
  if (scheduleId !== null) {
    if (!SCHEDULE_ID_RE.test(scheduleId)) throw new UsageError(`bad schedule id: ${fromFlag}`);
    if (!selfId) {
      throw new UsageError(
        "--from schedule:<id> works only inside the Paseo agent a schedule launched (bot-dm checks it against the schedule's run record)",
      );
    }
    if (!SCHEDULE_KINDS.includes(kind)) throw new UsageError("schedule senders may only send --kind report or --kind info");
    if (opt["expects-reply"]) throw new UsageError("a schedule run cannot receive replies; drop --expects-reply");
  } else if (worker) {
    if (!WORKER_NAME_RE.test(fromFlag)) throw new UsageError(`bad worker name: ${fromFlag}`);
    if (fromFlag.startsWith(SCHEDULE_SENDER_PREFIX)) {
      throw new UsageError(`${SCHEDULE_SENDER_PREFIX}* names are reserved for schedule runs (--from schedule:<id>, inside the run's agent)`);
    }
    if (selfId) throw new UsageError("--from worker:<name> is only for callers outside a Paseo agent");
    if (kind !== "report" && kind !== "resume" && !(kind === "info" && isSystemSender(fromFlag))) {
      throw new UsageError("worker senders may only send --kind report (or --kind resume / info from a system sender)");
    }
    if (opt.re !== undefined) throw new UsageError("worker reports start a new thread; drop --re");
    opt["new-thread"] = true;
  } else if (fromFlag !== undefined && !selfId) {
    if (env.BOT_DM_OPERATOR !== "1") {
      throw new UsageError(
        "outside a Paseo agent, --from must be worker:<name> (with --kind report). Operators testing as a bot set BOT_DM_OPERATOR=1.",
      );
    }
    if (!isBotName(fromFlag)) throw new UsageError(`"${fromFlag}" is not a bot name`);
  } else if (!selfId) {
    throw new UsageError("not running inside a Paseo agent; herdr workers use --from worker:<name> --kind report");
  }

  // Escalation bot: BOT_DM_FC, else the `escalation` setting; "" when there is none.
  const fc = env.BOT_DM_FC || settings.escalation || "";
  const root = botsRoot(env);
  const paseo = await deps.connect();
  try {
    const agents = await paseo.listAgents();

    let from: string;
    let fromAgent: AgentInfo | null = null;
    let fromDir: string | null;
    let owner: string | null = null;
    let schedule: ScheduleInfo | null = null;
    if (scheduleId !== null) {
      // Verified, not self-declared: the daemon writes each run's agent id into the schedule's run
      // record before the agent starts, and keeps the run "running" until it ends. Labels
      // (paseo.schedule-id) are settable by any agent, so they are not trusted here.
      schedule = await paseo.inspectSchedule(scheduleId);
      if (!schedule) throw new UsageError(`no Paseo schedule ${scheduleId}`);
      if (schedule.targetType !== "new-agent") {
        throw new UsageError(`schedule ${scheduleId} prompts an existing agent; that agent sends as itself, not as the schedule`);
      }
      if (!schedule.runs.some((r) => r.status === "running" && r.agentId === selfId)) {
        throw new UsageError(`caller agent ${selfId} is not the running agent of schedule ${scheduleId} (checked against the schedule's run record)`);
      }
      owner = scheduleOwner(schedule.cwd, root, (name) => profileName(join(root, name)) !== null);
      if (!owner) {
        throw new UsageError(
          `schedule ${scheduleId} has no owning bot: its folder ${schedule.cwd} is not ${root}/<bot> or under ${root}/<bot>-runs/`,
        );
      }
      from = scheduleSender(scheduleId);
      fromAgent = agents.find((a) => a.id === selfId) ?? null;
      fromDir = join(stateRoot(env), "workers", from.slice("worker:".length));
    } else if (selfId) {
      fromAgent = agents.find((a) => a.id === selfId) ?? null;
      const name = fromAgent ? botNameOf(fromAgent, root) : null;
      if (!fromAgent || !name) {
        const sched = fromAgent?.labels["paseo.schedule-id"];
        throw new UsageError(
          `caller agent ${selfId} is not a bot (no bot= label or bot folder); only bots send DMs` +
            (sched ? `. A schedule run reports to its bot with --from schedule:${sched} --kind report (or info)` : ""),
        );
      }
      if (fromFlag !== undefined && fromFlag !== name) throw new UsageError(`--from ${fromFlag} does not match the caller, ${name}`);
      from = name;
      fromDir = botDmDir(from, fromAgent, root);
    } else if (worker) {
      from = fromFlag!;
      fromDir = join(stateRoot(env), "workers", from.slice("worker:".length));
    } else {
      from = fromFlag!;
      fromAgent = chatFor(from, agents, root);
      fromDir = botDmDir(from, fromAgent, root);
    }
    if (!fromDir) throw new UsageError(`cannot find the DM folder for sender ${from}`);
    if (from === to) throw new UsageError("refusing to DM yourself");

    if (toUser) {
      const now = deps.now();
      const workerName = from.startsWith("worker:") && !schedule ? from.slice("worker:".length) : null;
      // Whose 10-minute slot this push uses: the bot's own; a schedule run's owner; a herdr
      // worker's launching bot (launch registry), else the worker's own.
      const limitKey = schedule ? owner! : worker ? await launchingBot(from.slice("worker:".length), agents, root, env, now) : null;
      return await sendToUser({
        id: opt.id ?? ulid(now.getTime()),
        now,
        from,
        limitKey,
        slotsPath: defaultSlotsPath(env),
        displayName: schedule
          ? `${botDisplayName(owner!, join(root, owner!))} (schedule)`
          : workerName
            ? `${workerName} (worker)`
            : botDisplayName(from, dirname(fromDir)),
        fromAgent: fromAgent && !schedule && !worker ? { id: fromAgent.id, workspaceId: fromAgent.workspaceId ?? null } : null,
        fromDir,
        kind,
        body,
        subject,
        attachments,
        expectsReply: opt["expects-reply"] || defaultExpectsReply(kind),
        retry: opt.id !== undefined,
        dryRun: opt["dry-run"],
        push: deps.push ? deps.push() : httpPush(env),
        clock: deps.now,
        out: deps.out,
        err: deps.err,
      });
    }

    const target = chatFor(to, agents, root);
    const toDir = target ? botDmDir(to, target, root) : null;

    const dryRun = opt["dry-run"];
    const now = deps.now();
    const id = opt.id ?? ulid(now.getTime());
    const activeTurnBehavior: ActiveTurnBehavior = opt.interrupt ? "interrupt" : "steer";
    const base = { id, from, to, kind, agentId: target?.id ?? null, recipientStatus: target?.status ?? null };

    const status = (s: DmStatusValue, detail: string | null, at = deps.now()): DmStatus => ({
      v: DM_SCHEMA_VERSION,
      type: "status",
      id,
      ts: at.toISOString(),
      status: s,
      detail,
    });
    const message = (thread: string, re: string | null, hop: number, text: string, expects: boolean): DmMessage => ({
      v: DM_SCHEMA_VERSION,
      type: "message",
      id,
      ts: now.toISOString(),
      from,
      to,
      kind,
      thread,
      re,
      hop,
      subject,
      body: text,
      attachments,
      expects_reply: expects,
      from_agent_id: fromAgent?.id ?? null,
      to_agent_id: target?.id ?? null,
      origin: DM_ORIGIN,
    });

    // ---- checks and ledger writes, under the ledger locks -----------------------------------
    type Plan =
      | { action: "refuse"; refusal: Refusal; record: DmMessage }
      | { action: "duplicate"; last: DmStatus }
      | { action: "send"; record: DmMessage; retry: boolean }
    | { action: "busy"; status: string };

    let inferred: Inferred | null = null;
    const decide = (write: boolean): Plan => {
      inferred = null;
      const outbox = readRecords(ledgerPath(fromDir!, "outbox"));
      const expects = opt["expects-reply"] || defaultExpectsReply(kind);

      // Retry of a known id: same content resends; different content is a conflict.
      const existing = outbox.find((r): r is DmMessage => r.type === "message" && r.id === id);
      if (existing) {
        if (existing.to !== to || existing.kind !== kind || existing.body !== body || (opt.re !== undefined && existing.re !== opt.re)) {
          throw new UsageError(`id ${id} was already used for a different message; drop --id to get a new one`);
        }
        const last = lastStatus(outbox, id);
        if (last?.status === "refused") throw new UsageError(`id ${id} was refused (${last.detail}); fix the cause and send without --id`);
        if (last && (last.status === "steered" || last.status === "started")) return { action: "duplicate", last };
        if (write && toDir && !readRecords(ledgerPath(toDir, "inbox")).some((r) => r.id === id)) {
          appendRecord(toDir, "inbox", existing);
        }
        return { action: "send", record: existing, retry: true };
      }

      let thread = id;
      let hop = 1;
      let refusal: Refusal | null = null;
      const refusedIds = new Set(outbox.filter((r) => r.type === "status" && r.status === "refused").map((r) => r.id));
      const known = [...outbox, ...readRecords(ledgerPath(fromDir!, "inbox"))];
      const messages = known.filter((r): r is DmMessage => r.type === "message" && !refusedIds.has(r.id));
      let re = opt.re ?? null;
      if (re === null && !opt["new-thread"]) {
        inferred = inferParent(messages, from, to, kind, body, now.getTime());
        re = inferred?.parent.id ?? null;
      }
      if (kind === "reply" && re === null) {
        throw new UsageError(`--kind reply needs --re <dm-id>; no DM from ${to} to answer was found`);
      }
      if (!target || !toDir) {
        refusal = {
          code: "unknown_recipient",
          reason: target ? `${to} has no DM folder` : `no live chat for a bot named ${to}`,
          advice: "Check the name: it is the bot's folder under ~/bots.",
        };
      }
      refusal ??= checkAllowed(from, to, kind, fc, owner);
      if (!refusal && re !== null) {
        const parent = inferred?.parent ?? findMessage(fromDir!, re);
        if (!parent) throw new UsageError(`--re ${re}: no such DM in ${from}'s inbox or outbox`);
        const threaded = checkReply({ parent, from, to, kind, threadHop: threadHop(messages, parent.thread) }, fc, Number(env.BOT_DM_HOP_CAP) || undefined);
        ({ thread, hop } = threaded);
        refusal = threaded.refusal;
      }
      refusal ??= checkSize(body);
      refusal ??= checkRate(countRecent(outbox, from, to, now.getTime()), to);
      if (!worker) refusal ??= checkPair(countPair(known as Array<DmMessage | DmStatus>, from, to, now.getTime()), from, to, kind, fc, Number(env.BOT_DM_PAIR_CAP) || undefined);
      if (refusal && inferred?.by === "recent" && refusal.code === "hop_cap") {
        refusal = { ...refusal, advice: `${refusal.advice} (bot-dm threaded this onto ${inferred.parent.id}, the open DM from ${to}. If it is a genuinely new topic, resend with --new-thread.)` };
      }

      if (refusal) {
        const record = message(thread, re, hop, clampBody(body), expects);
        if (write) {
          appendRecord(fromDir!, "outbox", record, now);
          appendRecord(fromDir!, "outbox", status("refused", refusal.code), now);
        }
        return { action: "refuse", refusal, record };
      }
      const record = message(thread, re, hop, body, expects);
      if (write) {
        appendRecord(fromDir!, "outbox", record, now);
        appendRecord(toDir!, "inbox", record, now);
        appendRecord(fromDir!, "outbox", status("queued", null), now);
      }
      return { action: "send", record, retry: false };
    };

    // --only-if-idle: a DM that passes every rule is sent only if the recipient is not busy. The
    // status is read afresh (one daemon round trip) after the rule checks, under the ledger locks,
    // so only the ledger appends and the send request itself lie between the check and the send.
    // Paseo has no atomic "send only if idle", so a turn that starts in that gap is steered into.
    const onlyIfIdle = opt["only-if-idle"];
    let freshStatus: string | null = null;
    const busyNow = async (): Promise<string | null> => {
      freshStatus = (await paseo.agentStatus(target!.id)) ?? target!.status;
      return BUSY_STATUSES.includes(freshStatus) ? freshStatus : null;
    };
    const guarded = async (write: boolean): Promise<Plan> => {
      if (onlyIfIdle) {
        const probe = decide(false);
        if (probe.action === "send") {
          const busy = await busyNow();
          if (busy) return { action: "busy", status: busy };
        }
      }
      return decide(write);
    };
    const plan = dryRun ? await guarded(false) : await withLocks([fromDir, ...(toDir ? [toDir] : [])], () => guarded(true));

    if (plan.action === "busy") {
      const output = {
        ok: false,
        ...base,
        recipientStatus: plan.status,
        status: "busy",
        reason: `${to} is ${plan.status}; --only-if-idle sends only to a recipient that is not busy`,
        ...(dryRun ? { dryRun: true } : {}),
      };
      deps.out(JSON.stringify(output));
      deps.err(`bot-dm: not sent: ${to} is ${plan.status} (--only-if-idle). Nothing written; try again later.`);
      return { exit: EXIT_BUSY, output };
    }

    if (plan.action === "duplicate") {
      const output = { ok: true, duplicate: true, ...base, status: plan.last.status };
      deps.out(JSON.stringify(output));
      return { exit: 0, output };
    }
    if (plan.action === "refuse") {
      const output = {
        ok: false,
        ...base,
        thread: plan.record.thread,
        hop: plan.record.hop,
        status: "refused",
        detail: plan.refusal.code satisfies DmRefusalCode,
        reason: plan.refusal.reason,
        advice: plan.refusal.advice,
        ...(dryRun ? { dryRun: true } : {}),
      };
      deps.out(JSON.stringify(output));
      deps.err(`bot-dm: refused (${plan.refusal.code}): ${plan.refusal.reason}. ${plan.refusal.advice}`);
      return { exit: 3, output };
    }

    const r = plan.record;
    const envelope = formatEnvelope({ id, from, to, kind: r.kind, hop: r.hop, re: r.re, expects_reply: r.expects_reply });
    // Envelope first, always: a text starting with "/" would make Paseo fall back to interrupt.
    // Second line: exactly one note saying who sent it and that it is not the owner.
    const note =
      r.kind === "resume" || (r.kind === "info" && isSystemSender(r.from))
        ? resumeNote(r.from)
        : schedule
          ? scheduleNote(schedule.id, schedule.name)
          : senderNote(r.from, botDisplayName(r.from, worker ? null : dirname(fromDir)), r.body);
    const text =
      `${envelope}\n` +
      `${note}\n` +
      r.body +
      (r.attachments.length ? `\nAttachments:\n${r.attachments.map((p) => `- ${p}`).join("\n")}` : "") +
      replyHint(r);
    const threading = inferred as Inferred | null;
    if (threading) deps.err(`bot-dm: threaded onto ${threading.parent.id} (${threading.by === "mention" ? "quoted in the text" : `unanswered DM from ${to}`}); use --new-thread for a separate topic.`);
    const result = {
      ...base,
      thread: r.thread,
      hop: r.hop,
      re: r.re,
      ...(threading ? { inferredRe: threading.parent.id, inferredBy: threading.by } : {}),
      expectsReply: r.expects_reply,
      activeTurnBehavior,
      ...(plan.retry ? { retry: true } : {}),
      paseoCli: { version: paseo.cli.version, pinned: paseo.cli.pinned },
    };
    if (dryRun) {
      const output = { ok: true, dryRun: true, ...result, text };
      deps.out(JSON.stringify(output));
      return { exit: 0, output };
    }

    let final: DmStatus;
    let exit = 0;
    try {
      await paseo.send(target!.id, text, { messageId: id, activeTurnBehavior });
      // The daemon only says "accepted"; the recipient's status just before sending is the proxy.
      final = status((freshStatus ?? target!.status) === "running" && !opt.interrupt ? "steered" : "started", opt.interrupt ? "interrupt" : null);
    } catch (error) {
      // agent_request_key_conflict: the daemon saw this id with a different text.
      final = status("failed", error instanceof Error ? error.message : String(error));
      exit = 1;
    }
    await withLocks([fromDir], () => appendRecord(fromDir!, "outbox", final));
    const output = { ok: exit === 0, ...result, status: final.status, ...(final.detail ? { detail: final.detail } : {}), sentAt: final.ts };
    deps.out(JSON.stringify(output));
    if (exit) deps.err(`bot-dm: send ${id} to ${to} failed: ${final.detail}. Retry with --id ${id}.`);
    return { exit, output };
  } finally {
    await paseo.close().catch(() => {});
  }
}

/**
 * Last line of the delivered text: the exact command to answer or follow up, with this DM's id.
 * Not stored in the ledger. Workers cannot receive DMs, so their reports get none.
 */
export function replyHint(r: DmMessage): string {
  if (r.from.startsWith("worker:")) return "";
  return r.expects_reply
    ? `\n(To answer: bot-dm ${r.from} --kind reply --re ${r.id} --text "...")`
    : `\n(No answer needed. To add to this thread: bot-dm ${r.from} --kind info --re ${r.id} --text "...")`;
}

/** Real process wiring, used by bin/bot-dm.mjs. */
export async function main(): Promise<never> {
  const { connectPaseo } = await import("./paseo.ts");
  const result = await run(process.argv.slice(2), {
    env: process.env,
    connect: () => connectPaseo(process.env),
    now: () => new Date(),
    readStdin: async () => {
      let data = "";
      for await (const chunk of process.stdin) data += chunk;
      return data;
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(result.exit);
}

