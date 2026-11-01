/**
 * Sending a system DM with bot-dm from the plugin process (no Paseo agent): push-slot notices,
 * and add-ons such as a stall watcher (they get botDmSender through the extension API).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Sends one DM; true when bot-dm accepted it. */
export type DmSend = (dm: { to: string; id: string; text: string }) => Promise<boolean>;
/** @deprecated old name, kept for add-ons. */
export type StallSend = DmSend;

/** Time-sortable id in bot-dm's ULID format (26 Crockford base32 chars). */
export function ulid(now = Date.now()): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = A[t % 32] + time;
  return time + Array.from(randomBytes(16), (b) => A[b % 32]).join("");
}

/** bot-dm binary: PASEO_BOTS_BOT_DM, else ~/.local/bin/bot-dm, else this repo's bin, else PATH. */
export function botDmBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_BOTS_BOT_DM) return env.PASEO_BOTS_BOT_DM;
  const local = join(homedir(), ".local/bin/bot-dm");
  if (existsSync(local)) return local;
  return "bot-dm";
}

/**
 * Real sender: `bot-dm <bot> --from <system sender> --kind <kind> --id <id> --text …`, outside any
 * Paseo agent. `as`: the system sender and kind (push-slot-notify: worker:push-slot, resume).
 */
export function botDmSender(env: NodeJS.ProcessEnv = process.env, as: { from: string; kind: "info" | "resume" }): DmSend {
  return ({ to, id, text }) =>
    new Promise((resolve) => {
      const childEnv = { ...env };
      // bot-dm takes --from worker:… only from callers outside a Paseo agent.
      delete childEnv.PASEO_AGENT_ID;
      // The script's shebang needs `node` on PATH; the daemon's own node will do.
      if (basename(process.execPath).startsWith("node")) {
        childEnv.PATH = `${dirname(process.execPath)}:${childEnv.PATH ?? ""}`;
      }
      execFile(
        botDmBin(env),
        [to, "--from", as.from, "--kind", as.kind, "--id", id, "--text", text],
        { env: childEnv, timeout: 30_000 },
        (error) => resolve(!error),
      );
    });
}
