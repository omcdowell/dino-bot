import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import { AgentMessageQueue, isAgentBusyForQueue, type QueuedAgentMessage } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options: { busy?: () => boolean; fail?: (id: string) => boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-queues-"));
  directories.push(directory);
  const dispatched: string[] = [];
  const delivered: string[] = [];
  const snapshots: string[][] = [];
  const make = () =>
    new AgentMessageQueue({
      directory,
      logger: pino({ level: "silent" }),
      isBusy: () => options.busy?.() ?? false,
      dispatch: async (_agentId, message, behavior) => {
        if (options.fail?.(message.messageId)) throw new Error("provider down");
        dispatched.push(`${message.messageId}:${behavior}`);
      },
      onDelivered: async (_agentId, messageId) => {
        delivered.push(messageId);
      },
      onChange: (_agentId, snapshot) => {
        snapshots.push(snapshot.items.map((item) => item.messageId));
      },
    });
  return { directory, dispatched, delivered, snapshots, make };
}

function queued(messageId: string): QueuedAgentMessage {
  return { messageId, text: messageId, createdAt: "2026-10-10T00:00:00.000Z" };
}

test("hands over one message per idle edge, in order, and keeps the rest on disk", async () => {
  let busy = true;
  const { dispatched, delivered, make } = await fixture({ busy: () => busy });
  const queue = make();
  await queue.enqueue("a", queued("m1"));
  await queue.enqueue("a", queued("m2"));
  await queue.enqueue("a", queued("m1"));
  expect(queue.snapshot("a")?.items.map((item) => item.messageId)).toEqual(["m1", "m2"]);

  const reloaded = make();
  expect(await reloaded.load()).toEqual(["a"]);
  busy = false;
  reloaded.kick("a");
  reloaded.kick("a");
  await expect.poll(() => delivered).toEqual(["m1"]);
  expect(dispatched).toEqual(["m1:steer"]);
  reloaded.kick("a");
  await expect.poll(() => delivered).toEqual(["m1", "m2"]);
  expect(reloaded.snapshot("a")).toBeNull();
  expect(await make().load()).toEqual([]);
});

test("a failed hand-over keeps the message first and waits until the agent runs again", async () => {
  let down = true;
  const { delivered, make } = await fixture({ fail: () => down });
  const queue = make();
  await queue.enqueue("a", queued("m1"));
  await expect.poll(() => queue.holds("a", "m1") && !queue.wouldHold("x")).toBe(true);
  down = false;
  queue.kick("a");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(delivered).toEqual([]);
  queue.release("a");
  queue.kick("a");
  await expect.poll(() => delivered).toEqual(["m1"]);
});

test("withdraw and force take a message out exactly once", async () => {
  const { dispatched, make } = await fixture({ busy: () => true });
  const queue = make();
  await queue.enqueue("a", queued("m1"));
  await queue.enqueue("a", queued("m2"));
  expect(await queue.withdraw("a", "m1")).toBe(true);
  expect(await queue.withdraw("a", "m1")).toBe(false);
  expect(await queue.force("a", "m2")).toBe("forced");
  expect(await queue.force("a", "m2")).toBe("not_queued");
  expect(dispatched).toEqual(["m2:steer"]);
});

test("an agent whose last turn failed takes the next message (the chat is not stuck)", () => {
  const idle = {
    lifecycle: "idle",
    pendingReplacement: false,
    activeForegroundTurnId: null,
  };
  expect(isAgentBusyForQueue({ ...idle, lifecycle: "error" })).toBe(false);
  expect(isAgentBusyForQueue(idle)).toBe(false);
  expect(isAgentBusyForQueue({ ...idle, lifecycle: "running" })).toBe(true);
  expect(isAgentBusyForQueue({ ...idle, lifecycle: "initializing" })).toBe(true);
  expect(isAgentBusyForQueue({ ...idle, pendingReplacement: true })).toBe(true);
  expect(
    isAgentBusyForQueue({
      ...idle,
      lifecycle: "error",
      activeForegroundTurnId: "t1",
    }),
  ).toBe(true);
});
