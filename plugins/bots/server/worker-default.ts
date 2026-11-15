/**
 * The host's default engine for herdr workers (owner, 15 Nov: "claude code if signed in, pi if signed in ... have in
 * app settings only let you change the global default and say if you want more fine grained, ask your bots").
 * The setting is `workerEngine` in the bots settings file (settings.ts); the workers skill's launch.sh reads it at every
 * launch (skills/workers/worker-default.mjs), after the bot's own `.bot.json` `workers` and before the automatic
 * choice. This module answers the app: the setting, and what it means right now.
 */
import type { WorkerDefaultDto } from "../shared/workers-rpc";
import { readSettingsAt, writeWorkerEngine } from "./settings";

export interface WorkerDefaultDeps {
  /** Claude Code is signed in (launch.ts claudeSignedIn). */
  claudeSignedIn: () => Promise<boolean>;
  /** Providers pi is signed in to (manage.ts piSignIns). */
  piSignIns: () => string[];
  env?: NodeJS.ProcessEnv;
}

export async function workerDefault(root: string, deps: WorkerDefaultDeps): Promise<WorkerDefaultDto> {
  const env = deps.env ?? process.env;
  const engine = readSettingsAt(root, env).workerEngine;
  // A proxy for cc workers (CC_WORKER_BASE_URL) holds the login itself: Claude Code counts as signed in.
  const claudeCode = !!env.CC_WORKER_BASE_URL?.trim() || (await deps.claudeSignedIn().catch(() => false));
  const pi = deps.piSignIns().length > 0;
  return { engine: engine ?? "auto", effective: engine ?? (claudeCode ? "cc" : "pi"), claudeCode, pi };
}

export async function setWorkerDefault(root: string, engine: WorkerDefaultDto["engine"], deps: WorkerDefaultDeps): Promise<WorkerDefaultDto> {
  writeWorkerEngine(root, engine === "auto" ? null : engine, deps.env ?? process.env);
  return workerDefault(root, deps);
}
