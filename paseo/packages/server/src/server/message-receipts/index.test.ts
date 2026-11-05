import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("a pending receipt the agent's history shows as delivered completes without a resend", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  let delivered = false;
  const input = {
    agentId: "agent",
    messageId: "dropped-socket",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
      delivered = true;
      throw new Error("wait_for_agent_start aborted");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("wait_for_agent_start aborted");
  const retry = {
    ...input,
    resolve: () => (delivered ? ("delivered" as const) : ("unknown" as const)),
  };
  await new MessageReceipts(directory).send(retry);
  await new MessageReceipts(directory).send(retry);
  expect(deliveries).toBe(1);
});

test("a send that reached the agent before failing still counts as delivered", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "late-abort",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("socket closed after turn start");
    },
    resolve: () => "delivered" as const,
  };
  await requests.send(input);
  await new MessageReceipts(directory).send({ ...input, resolve: () => "unknown" as const });
  expect(deliveries).toBe(1);
});

test("a definite start failure clears the receipt so the same id can be retried", async () => {
  const { requests } = await fixture();
  let attempts = 0;
  const input = {
    agentId: "agent",
    messageId: "start-failed",
    request: {},
    send: async () => {
      attempts++;
      if (attempts === 1) throw new Error("provider refused the turn");
    },
    resolve: () => (attempts === 1 ? ("failed" as const) : ("unknown" as const)),
  };
  await expect(requests.send(input)).rejects.toThrow("provider refused the turn");
  await requests.send(input);
  expect(attempts).toBe(2);
});

test("an unresolvable pending receipt is still never replayed", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "restart",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("daemon stopped");
    },
    resolve: () => "unknown" as const,
  };
  await expect(requests.send(input)).rejects.toThrow("daemon stopped");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("the recorded hook fires once the receipt is durable, and again for a duplicate", async () => {
  const { requests } = await fixture();
  const events: string[] = [];
  const input = {
    agentId: "agent",
    messageId: "ack",
    request: {},
    send: async () => {
      events.push("send");
    },
    onRecorded: (state: string) => {
      events.push(`recorded:${state}`);
    },
  };
  await requests.send(input);
  await requests.send(input);
  expect(events).toEqual(["recorded:new", "send", "recorded:completed"]);
});

test("cancel leaves a tombstone that drops a later send, also after a restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "deleted-offline",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  expect(await requests.cancel({ agentId: "agent", messageId: "deleted-offline" })).toBe(
    "cancelled",
  );
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow("cancelled");
  expect(deliveries).toBe(0);
});

test("a held message stays pending until it is handed over, and can be withdrawn meanwhile", async () => {
  const { requests } = await fixture();
  let held = true;
  const input = (messageId: string) => ({
    agentId: "agent",
    messageId,
    request: {},
    send: async () => "held" as const,
    resolve: () => (held ? ("held" as const) : ("unknown" as const)),
  });
  await requests.send(input("queued"));
  await requests.send(input("queued"));
  expect(
    await requests.cancel({ agentId: "agent", messageId: "queued", withdraw: () => true }),
  ).toBe("cancelled");

  await requests.send(input("taken"));
  await requests.complete("agent", "taken");
  held = false;
  await requests.send(input("taken"));
  expect(
    await requests.cancel({ agentId: "agent", messageId: "taken", withdraw: () => true }),
  ).toBe("too_late");

  await requests.send(input("dispatching"));
  expect(
    await requests.cancel({ agentId: "agent", messageId: "dispatching", withdraw: () => false }),
  ).toBe("too_late");
});
