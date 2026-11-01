import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

// Chat desync (Sam 2026-10-11, iPhone on LTE): after reconnects during a bot reply, the app
// showed a reply twice and put the next reply above the question it answers. The daemon's
// timeline was right. Rule: the rendered order equals the daemon's order, with no duplicates.

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        omp: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    },
  },
});

// One entry per turn: the user prompt, then all assistant text up to the next prompt (the app
// splits one assistant message into several rows, so text is compared per turn, alphanumerics only).
interface Turn {
  user: string;
  assistant: string;
}

function alnum(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function renderedTurns(page: Page): Promise<Turn[]> {
  // A reload can still be navigating while this polls; that reads as "nothing rendered yet".
  const rows = await page
    .locator('[data-testid="user-message"], [data-testid="assistant-message"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        user: node.getAttribute("data-testid") === "user-message",
        text: node.textContent ?? "",
      })),
    )
    .catch(() => []);
  return toTurns(rows);
}

function toTurns(rows: Array<{ user: boolean; text: string }>): Turn[] {
  const turns: Turn[] = [];
  for (const row of rows) {
    if (row.user) turns.push({ user: alnum(row.text), assistant: "" });
    else if (turns.length === 0) turns.push({ user: "", assistant: alnum(row.text) });
    else turns[turns.length - 1]!.assistant += alnum(row.text);
  }
  return turns;
}

type SeededAgent = Awaited<ReturnType<typeof seedMockAgentWorkspace>>;

// The seed client is the daemon client; its e2e type lists only what the shared helpers use.
interface TimelineSeedClient {
  fetchAgentTimeline(
    agentId: string,
    request: { direction: "tail"; limit: number; projection: "projected" },
  ): Promise<{ entries: Array<{ item: { type: string; text?: string } }> }>;
  updateAgent(agentId: string, input: { labels: Record<string, string> }): Promise<unknown>;
}

function timelineClient(agent: SeededAgent): TimelineSeedClient {
  return agent.client as unknown as TimelineSeedClient;
}

async function daemonTurns(agent: SeededAgent) {
  const page = await timelineClient(agent).fetchAgentTimeline(agent.agentId, {
    direction: "tail",
    limit: 0,
    projection: "projected",
  });
  const rows: Array<{ user: boolean; text: string }> = [];
  for (const entry of page.entries) {
    if (entry.item.type === "user_message") rows.push({ user: true, text: entry.item.text ?? "" });
    if (entry.item.type === "assistant_message") {
      rows.push({ user: false, text: entry.item.text ?? "" });
    }
  }
  return toTurns(rows);
}

function sameTurns(allRendered: Turn[], allDaemon: Turn[]): boolean {
  // Older rows can be virtualised away: a leading group without its prompt is partial, and the
  // rendered turns are compared with the daemon's newest turns.
  const rendered = allRendered[0]?.user === "" ? allRendered.slice(1) : allRendered;
  if (rendered.length === 0) return false;
  const daemon = allDaemon.slice(-rendered.length);
  return (
    rendered.length === daemon.length &&
    rendered.every(
      (turn, index) =>
        // The rendered prompt row also carries its time and ticks.
        turn.user.startsWith(daemon[index]!.user) && turn.assistant === daemon[index]!.assistant,
    )
  );
}

function describeTurns(turns: Turn[]): string {
  return JSON.stringify(
    turns.map((turn) => ({
      user: turn.user.slice(0, 30),
      assistantChars: turn.assistant.length,
      head: turn.assistant.slice(0, 40),
    })),
  );
}

async function expectRowsMatchDaemon(page: Page, agent: SeededAgent, label: string): Promise<void> {
  const daemon = await daemonTurns(agent);
  let rendered: Turn[] = [];
  await expect
    .poll(
      async () => {
        rendered = await renderedTurns(page);
        return sameTurns(rendered, daemon);
      },
      { timeout: 20_000, message: label },
    )
    .toBe(true)
    .catch((error: unknown) => {
      console.log(
        `[chat-desync] ${label}\n daemon: ${describeTurns(daemon)}\n app:    ${describeTurns(rendered)}`,
      );
      throw error;
    });
  console.log(`[chat-desync] ${label} ok (${rendered.length} turns)`);
}

async function waitForReplyStarted(agent: SeededAgent, turns: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const daemon = await daemonTurns(agent);
        return daemon.length >= turns && daemon[turns - 1]!.assistant.length > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test("reconnects during a bot reply keep the daemon's order without duplicates", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-desync-",
    title: "Chat desync",
    model: "ten-second-stream",
  });
  try {
    await timelineClient(agent).updateAgent(agent.agentId, {
      labels: { "paseo.send-behavior": "queue", "paseo.keep-live": "1" },
    });
    await agent.client.sendAgentMessage(agent.agentId, "chat-desync turn one");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);
    await waitForReplyStarted(agent, 1);
    await expectRowsMatchDaemon(page, agent, "after open");

    // Round 1: the phone's pattern (two drops a few seconds apart) while the reply streams.
    await submitMessage(page, "chat-desync turn two");
    await waitForReplyStarted(agent, 2);
    await page.waitForTimeout(1_500);
    await gate.drop();
    await page.waitForTimeout(2_000);
    gate.restore();
    await page.waitForTimeout(1_500);
    await gate.drop();
    await page.waitForTimeout(700);
    gate.restore();
    await agent.client.waitForFinish(agent.agentId, 60_000);
    await expectRowsMatchDaemon(page, agent, "round 1 (two drops mid-reply)");

    // Round 2: the link dies mid-reply and only comes back after the turn has finished.
    await submitMessage(page, "chat-desync turn three");
    await waitForReplyStarted(agent, 3);
    await gate.drop();
    await agent.client.waitForFinish(agent.agentId, 60_000);
    gate.restore();
    await expectRowsMatchDaemon(page, agent, "round 2 (back after the turn)");

    // Round 3: message sent while the link is down (outbox), link back mid-reply.
    await gate.drop();
    await submitMessage(page, "chat-desync turn four");
    await page.waitForTimeout(1_000);
    gate.restore();
    await waitForReplyStarted(agent, 4);
    await page.waitForTimeout(2_000);
    await gate.drop();
    await page.waitForTimeout(1_000);
    gate.restore();
    await agent.client.waitForFinish(agent.agentId, 60_000);
    await expectRowsMatchDaemon(page, agent, "round 3 (sent offline)");
  } finally {
    gate.restore();
    await agent.cleanup();
  }
});

// A reload (cold start from the device cache) while a reply streams. The chat is painted from the
// cache first; live chunks wait for the first page from the daemon instead of being drawn over the
// cached rows. Before that fix the end of the reply went missing in most runs.
test("a reload mid-reply ends with the daemon's rows", async ({ page }) => {
  test.setTimeout(240_000);
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-desync-reload-",
    title: "Chat desync reload",
    model: "ten-second-stream",
  });
  try {
    await timelineClient(agent).updateAgent(agent.agentId, {
      labels: { "paseo.send-behavior": "queue", "paseo.keep-live": "1" },
    });
    await agent.client.sendAgentMessage(agent.agentId, "chat-desync turn one");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);
    await expectRowsMatchDaemon(page, agent, "after open");
    await submitMessage(page, "chat-desync turn two");
    await waitForReplyStarted(agent, 2);
    await page.waitForTimeout(1_500);
    await page.reload({ waitUntil: "commit" });
    await page.waitForTimeout(1_500);
    await gate.drop();
    await page.waitForTimeout(1_000);
    gate.restore();
    await agent.client.waitForFinish(agent.agentId, 60_000);
    await expectRowsMatchDaemon(page, agent, "reload mid-reply");
  } finally {
    gate.restore();
    await agent.cleanup();
  }
});
