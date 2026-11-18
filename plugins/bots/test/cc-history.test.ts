// A reopened Claude Code bot chat (L2): the history comes from the bot's OptChat log, as before, and now shows its tool
// calls too (each `tool` entry with the result its `echo` logged), not only the messages.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { replayItems } from "../server/cc/provider";

const e = (i: number, kind: string, text: string) => ({ i, kind, text, date: `2026-11-18T00:00:0${i}Z` }) as any;

describe("cc provider: history of a reopened chat", () => {
  it("messages, and tool calls paired with their results by name in order", () => {
    const items = replayItems([
      e(0, "user", "list it"),
      e(1, "talk", "Looking."),
      e(2, "tool", 'Bash {"command":"ls"}'),
      e(3, "tool", 'Read {"file_path":"/a"}'),
      e(4, "echo", "Bash: a\nb"),
      e(5, "echo", "Read: [error] no such file"),
      e(6, "tool", "zoom not json"),
      e(7, "talk", "Done."),
    ]);
    assert.deepEqual(
      items.map((x) => [x.timestamp, x.item.type, x.item.id, (x.item as any).text ?? (x.item as any).name, (x.item as any).status]),
      [
        ["2026-11-18T00:00:00Z", "user_message", "m-0", "list it", undefined],
        ["2026-11-18T00:00:01Z", "assistant_message", "m-1", "Looking.", undefined],
        ["2026-11-18T00:00:02Z", "tool_call", "m-2", "Bash", "completed"],
        ["2026-11-18T00:00:03Z", "tool_call", "m-3", "Read", "failed"],
        ["2026-11-18T00:00:06Z", "tool_call", "m-6", "zoom", "completed"],
        ["2026-11-18T00:00:07Z", "assistant_message", "m-7", "Done.", undefined],
      ],
    );
    const bash = items[2]!.item as any;
    assert.equal(bash.callId, "m-2");
    assert.deepEqual(bash.detail, { type: "shell", command: "ls", output: "a\nb", exitCode: 0 });
    assert.equal((items[3]!.item as any).error, "no such file");
  });
});
