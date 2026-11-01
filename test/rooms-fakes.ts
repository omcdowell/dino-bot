import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomAgent, RoomsPaseo } from "../server/rooms/sessions";

/** A bots root with `.optchat-profile` folders and a `.groups.json`, plus an empty rooms root. */
export function fixture(bots = ["wallace", "scrat", "peggy"], groups?: unknown) {
  const base = mkdtempSync(join(tmpdir(), "rooms-"));
  const botsRoot = join(base, "bots");
  const roomsRoot = join(base, "state", "bot-rooms");
  for (const bot of bots) {
    mkdirSync(join(botsRoot, bot), { recursive: true });
    writeFileSync(join(botsRoot, bot, ".optchat-profile"), `${bot}\n`);
  }
  writeFileSync(
    join(botsRoot, ".groups.json"),
    JSON.stringify(
      groups ?? { v: 1, groups: [{ id: "alarm-clock", name: "Alarm Clock", members: bots, lead: bots[0] }] },
    ),
  );
  return { base, botsRoot, roomsRoot, optchatHome: join(base, "optchat") };
}

export type Created = {
  cwd: string;
  config: unknown;
  title?: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
  prompt?: string;
};

/** Fake Paseo: agents live in a map; nothing real is started. */
export function fakePaseo() {
  const agents = new Map<string, RoomAgent>();
  const created: Created[] = [];
  const sent: Array<{ agentId: string; text: string; options?: unknown }> = [];
  const archived: string[] = [];
  let n = 0;
  const paseo: RoomsPaseo = {
    agents: {
      list: async () => ({ entries: [...agents.values()].filter((a) => !a.archivedAt).map((agent) => ({ agent })) }),
      ref: (id) => ({
        send: async (text, options) => {
          const agent = agents.get(id);
          if (!agent || agent.archivedAt) throw new Error(`no agent ${id}`);
          sent.push({ agentId: id, text, options });
          agent.status = "running";
        },
        archive: async () => {
          const agent = agents.get(id);
          if (agent) agent.archivedAt = new Date().toISOString();
          archived.push(id);
          return {};
        },
      }),
    },
    workspaces: {
      open: async (cwd) => ({
        agents: {
          create: async (options) => {
            const id = `agent-${++n}`;
            created.push({ cwd, ...options });
            agents.set(id, { id, cwd, labels: options.labels ?? {}, status: options.prompt ? "running" : "idle" });
            return { id };
          },
        },
      }),
    },
    config: { get: async () => ({}) },
  };
  /** Ends the agent's turn in the fake (status idle). */
  const idle = (id: string) => {
    const agent = agents.get(id);
    if (agent) agent.status = "idle";
  };
  return { paseo, agents, created, sent, archived, idle };
}
