/**
 * bot-room: a bot's main chat posts into a group chat it is a member of, answering a room message (the task it was
 * given there). Built like bot-dm: the wrapper identifies the caller (PASEO_AGENT_ID, never the message text) and the
 * Paseo bots plugin (`rooms.bot-post`) does the checks, the ledger write and the routing. See USAGE.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BOT_ID_RE, GROUP_ID_RE } from "../shared/rooms/schema.ts";
import type { BotPostResult } from "../server/rooms/service.ts";

export const PLUGIN_ID = "bots";
export const METHOD = "rooms.bot-post";
/** Room message ids are ULIDs; anything id-like is passed on and checked against the ledger by the plugin. */
const RE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const MAX_TEXT = 8000;

export const USAGE = `Usage: bot-room post <group> --re <msg-id> (--text <body> | --file <path|->)

Post a short result into a group chat from your main chat, as yourself. Use it once when you
finish, or get stuck on, a task that reached you as "[room <group> task ... msg <id>]"; the task
message shows the exact command. Not for progress chatter, and never to answer a
"[room <group> block ...]" record.

  <group>              the group id, e.g. alarm-clock
  --re <msg-id>        the room message this answers (the task's msg id); the app shows the
                       post as a reply to it
  --text <body>        the post (at most ${MAX_TEXT} chars)
  --file <path|->      read the post from a file, or stdin with -
  --from <bot>         operators only, outside any Paseo agent, with BOT_ROOM_OPERATOR=1

The Bots plugin checks it: you must be a member of the group, --re must be a message in that
group, and the group's caps apply (the post's hop is the --re message's hop + 1, at most 6; it
takes one of the room's 6 bot wakes per 10 minutes). It wakes nobody, unless it @names members:
then the usual room rules and caps decide who is woken. The same text re the same message is
posted once (a retry is answered as a duplicate).
Exit: 0 posted (or already posted), 1 failed (daemon or plugin), 2 usage error, 3 refused.
Prints one JSON line.`;

export class UsageError extends Error {}

export interface RoomPort {
  invoke(method: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export type Deps = {
  env: NodeJS.ProcessEnv;
  connect: () => Promise<RoomPort>;
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type Result = { exit: number; output: Record<string, unknown> | null };

export async function run(argv: string[], deps: Deps): Promise<Result> {
  try {
    return await runInner(argv, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`bot-room: ${error.message}`);
      return { exit: 2, output: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    const hint = /does not contribute RPC/i.test(message) ? " (the Bots plugin running now has no bot-room support yet: it needs a plugin reload)" : "";
    deps.err(`bot-room: ${message}${hint}`);
    return { exit: 1, output: null };
  }
}

async function runInner(argv: string[], deps: Deps): Promise<Result> {
  const { env } = deps;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        re: { type: "string" },
        text: { type: "string" },
        file: { type: "string" },
        from: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${USAGE}`);
  }
  const { values: opt, positionals } = parsed;
  if (opt.help || positionals[0] === "help") {
    deps.out(USAGE);
    return { exit: 0, output: null };
  }
  const [command, group, ...rest] = positionals;
  if (command !== "post") throw new UsageError(`unknown command ${command === undefined ? "(none)" : JSON.stringify(command)}; the only command is post\n${USAGE}`);
  if (!group || rest.length) throw new UsageError("give exactly one group id: bot-room post <group> --re <msg-id> --text \"...\"");
  if (!GROUP_ID_RE.test(group)) throw new UsageError(`"${group}" is not a group id`);
  if (opt.re === undefined) throw new UsageError("--re <msg-id> is required: the room message this answers (the task's msg id)");
  if (!RE_ID_RE.test(opt.re)) throw new UsageError(`--re ${JSON.stringify(opt.re)} is not a room message id`);
  if ((opt.text === undefined) === (opt.file === undefined)) throw new UsageError("give exactly one of --text or --file");
  const body = (opt.text ?? (opt.file === "-" ? await deps.readStdin() : readFileSync(opt.file!, "utf8"))).trim();
  if (!body) throw new UsageError("empty message");
  if (body.length > MAX_TEXT) throw new UsageError(`the post is ${body.length} chars; at most ${MAX_TEXT}`);

  // ---- who is posting: the caller's agent (checked by the plugin), never the text ----
  const agentId = env.PASEO_AGENT_ID || undefined;
  let from: string | undefined;
  if (opt.from !== undefined) {
    if (!BOT_ID_RE.test(opt.from)) throw new UsageError(`"${opt.from}" is not a bot name`);
    if (!agentId && env.BOT_ROOM_OPERATOR !== "1") {
      throw new UsageError("--from is for operators outside a Paseo agent; set BOT_ROOM_OPERATOR=1");
    }
    from = opt.from;
  } else if (!agentId) {
    throw new UsageError("not running inside a Paseo agent (no PASEO_AGENT_ID); only a bot's main chat posts to its groups");
  }

  const input = { groupId: group, re: opt.re, text: body, ...(agentId ? { agentId } : {}), ...(from ? { from } : {}) };
  const port = await deps.connect();
  let res: BotPostResult;
  try {
    res = (await port.invoke(METHOD, input)) as BotPostResult;
  } finally {
    await port.close().catch(() => {});
  }
  if (!res || typeof res !== "object" || typeof res.ok !== "boolean") throw new Error(`unexpected answer from ${METHOD}: ${JSON.stringify(res)}`);
  const output = { ...res, group, re: opt.re } as Record<string, unknown>;
  deps.out(JSON.stringify(output));
  if (!res.ok) {
    deps.err(`bot-room: refused (${res.code ?? "refused"}): ${res.reason ?? "no reason given"}`);
    return { exit: 3, output };
  }
  if (res.duplicate) deps.err(`bot-room: already posted as ${res.id}; nothing new written.`);
  for (const r of res.refused ?? []) deps.err(`bot-room: posted, but not passed to ${r.bot} (${r.reason})`);
  return { exit: 0, output };
}

/** Real process wiring, used by bin/bot-room.mjs: the same daemon connection as bot-dm. */
export async function main(): Promise<never> {
  const { cliDist, loadCliInternals } = await import("../bot-dm/paseo.ts");
  const result = await run(process.argv.slice(2), {
    env: process.env,
    connect: async () => {
      const { connectToDaemon, selectDaemonTarget } = await loadCliInternals(cliDist(process.env));
      const client = await connectToDaemon({ target: selectDaemonTarget({}) });
      if (typeof client.invokePluginRpc !== "function") {
        await client.close?.().catch(() => {});
        throw new Error("Paseo DaemonClient has no invokePluginRpc()");
      }
      return {
        invoke: (method, input) => client.invokePluginRpc(PLUGIN_ID, method, input),
        close: () => client.close(),
      };
    },
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
