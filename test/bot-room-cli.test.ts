import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHOD, run, USAGE, type Deps } from "../bot-room/cli.ts";

function deps(env: NodeJS.ProcessEnv, answer: unknown | ((input: any) => unknown), stdin = "") {
  const calls: Array<{ method: string; input: any }> = [];
  const out: string[] = [];
  const err: string[] = [];
  let closed = 0;
  const d: Deps = {
    env,
    connect: async () => ({
      invoke: async (method, input) => {
        calls.push({ method, input });
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? (answer as (i: unknown) => unknown)(input) : answer;
      },
      close: async () => {
        closed += 1;
      },
    }),
    readStdin: async () => stdin,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { d, calls, out, err, closed: () => closed };
}

const OK = { ok: true, id: "01MPOST", from: "peggy", hop: 1, to: [], refused: [] };

test("bot-room post: sends group, re, text and the caller's PASEO_AGENT_ID to rooms.bot-post; prints one JSON line", async () => {
  const w = deps({ PASEO_AGENT_ID: "agent-peggy" }, OK);
  const r = await run(["post", "alarm-clock", "--re", "01MTASK", "--text", "  Done: docs/launch.md  "], w.d);
  assert.equal(r.exit, 0);
  assert.equal(METHOD, "rooms.bot-post");
  assert.deepEqual(w.calls, [{ method: "rooms.bot-post", input: { groupId: "alarm-clock", re: "01MTASK", text: "Done: docs/launch.md", agentId: "agent-peggy" } }]);
  assert.equal(w.out.length, 1);
  assert.deepEqual(JSON.parse(w.out[0]!), { ...OK, group: "alarm-clock", re: "01MTASK" });
  assert.equal(w.closed(), 1);
});

test("bot-room post: --file and --file - read the body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botroom-"));
  try {
    writeFileSync(join(dir, "r.md"), "from a file\n");
    const a = deps({ PASEO_AGENT_ID: "x" }, OK);
    assert.equal((await run(["post", "g1", "--re", "01M1", "--file", join(dir, "r.md")], a.d)).exit, 0);
    assert.equal(a.calls[0]!.input.text, "from a file");
    const b = deps({ PASEO_AGENT_ID: "x" }, OK, "from stdin\n");
    assert.equal((await run(["post", "g1", "--re", "01M1", "--file", "-"], b.d)).exit, 0);
    assert.equal(b.calls[0]!.input.text, "from stdin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bot-room post: a refusal prints the reason and exits 3", async () => {
  const w = deps({ PASEO_AGENT_ID: "agent-gromit" }, { ok: false, to: [], refused: [], code: "not_member", reason: "gromit is not a member of alarm-clock" });
  const r = await run(["post", "alarm-clock", "--re", "01MTASK", "--text", "hi"], w.d);
  assert.equal(r.exit, 3);
  assert.equal(JSON.parse(w.out[0]!).code, "not_member");
  assert.deepEqual(w.err, ["bot-room: refused (not_member): gromit is not a member of alarm-clock"]);
});

test("bot-room post: posted but a mention was capped: exit 0, a note on stderr", async () => {
  const w = deps({ PASEO_AGENT_ID: "a" }, { ...OK, refused: [{ bot: "wallace", reason: "rate_cap" }] });
  assert.equal((await run(["post", "alarm-clock", "--re", "01M", "--text", "@wallace done"], w.d)).exit, 0);
  assert.deepEqual(w.err, ["bot-room: posted, but not passed to wallace (rate_cap)"]);
});

test("bot-room post: usage errors exit 2 before connecting", async () => {
  const cases: Array<[string[], NodeJS.ProcessEnv, RegExp]> = [
    [["post", "alarm-clock", "--re", "01M", "--text", "hi"], {}, /not running inside a Paseo agent/],
    [["post", "alarm-clock", "--text", "hi"], { PASEO_AGENT_ID: "a" }, /--re <msg-id> is required/],
    [["post", "alarm-clock", "--re", "01M"], { PASEO_AGENT_ID: "a" }, /exactly one of --text or --file/],
    [["post", "alarm-clock", "--re", "01M", "--text", "  "], { PASEO_AGENT_ID: "a" }, /empty message/],
    [["post", "Bad Group", "--re", "01M", "--text", "x"], { PASEO_AGENT_ID: "a" }, /not a group id/],
    [["post", "alarm-clock", "--re", "../x", "--text", "x"], { PASEO_AGENT_ID: "a" }, /not a room message id/],
    [["send", "alarm-clock"], { PASEO_AGENT_ID: "a" }, /the only command is post/],
    [["post", "alarm-clock", "--re", "01M", "--text", "x", "--from", "peggy"], {}, /BOT_ROOM_OPERATOR=1/],
  ];
  for (const [argv, env, re] of cases) {
    const w = deps(env, OK);
    const r = await run(argv, w.d);
    assert.equal(r.exit, 2, argv.join(" "));
    assert.match(w.err.join("\n"), re);
    assert.equal(w.calls.length, 0);
  }
});

test("bot-room post: operator --from with BOT_ROOM_OPERATOR=1 sends from, no agentId", async () => {
  const w = deps({ BOT_ROOM_OPERATOR: "1" }, OK);
  assert.equal((await run(["post", "tmp-test", "--re", "01M", "--text", "x", "--from", "tmp-bot"], w.d)).exit, 0);
  assert.deepEqual(w.calls[0]!.input, { groupId: "tmp-test", re: "01M", text: "x", from: "tmp-bot" });
});

test("bot-room: --help prints the usage; a plugin without the RPC exits 1 with a reload hint", async () => {
  const h = deps({}, OK);
  assert.equal((await run(["--help"], h.d)).exit, 0);
  assert.equal(h.out[0], USAGE);
  const w = deps({ PASEO_AGENT_ID: "a" }, new Error("Request failed: Plugin bots does not contribute RPC rooms.bot-post"));
  assert.equal((await run(["post", "alarm-clock", "--re", "01M", "--text", "x"], w.d)).exit, 1);
  assert.match(w.err[0]!, /needs a plugin reload/);
});
