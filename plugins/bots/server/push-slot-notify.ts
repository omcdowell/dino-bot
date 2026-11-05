/**
 * "Your push slot to the owner is open again": one system DM to a bot whose push to the owner was
 * refused by the per-bot rate limit (paseo-apns, one push per 10 min per bot), sent when its slot
 * reopens. 2026-10-11: "each bot should get a one/10mins limit and be told when the limit
 * expires".
 *
 * Only after a refusal: a bot that pushed and was never refused gets nothing (each DM costs the bot
 * a turn). Several refusals in one window give one DM. Sent with bot-dm as the system sender
 * `worker:push-slot`, kind resume, so it arrives with the system-nudge line ("not a message from
 * The owner") and needs no reply.
 *
 * State is one append-only file, `$XDG_STATE_HOME/bot-dm/push-slots.jsonl`, so a pending notice
 * survives a plugin reload. bot-dm writes `refused` (bot-dm/to-user.ts); this notifier, on the bots
 * plugin's timer, claims (`notice`, with a DM id, before sending; a retry reuses the id so bot-dm
 * drops a duplicate) and closes (`notice-sent` / `notice-skipped`) every refusal up to `through`:
 *
 *   {"v":1,"type":"refused","ts":"…","bot":"bitzer","at":"…","retryAt":"…","dm":"<refused DM id>"}
 *   {"v":1,"type":"notice","ts":"…","bot":"bitzer","through":"<latest refusal at>","dm":"<ulid>"}
 *   {"v":1,"type":"notice-sent","ts":"…","bot":"bitzer","through":"…","dm":"<ulid>"}
 *   {"v":1,"type":"notice-skipped","ts":"…","bot":"bitzer","through":"…","reason":"slot-used|stale|attempts"}
 *
 * Skipped, not sent, when the bot's slot is already taken again by the time it is due (it pushed
 * after the window; it knows), or when the notice is over STALE_MS late (the plugin was down).
 *
 * Imports carry `.ts` extensions: bot-dm (run by Node with type stripping) imports recordRefusal.
 */
import { join } from "node:path";
import { tailLines } from "./tail.ts";
import { appendJsonl, stateRoot } from "./workers.ts";
import { ulid, type StallSend } from "./bot-dm-send.ts";
import { userName } from "../shared/party.ts";

export const SLOT_SENDER = "worker:push-slot";
export const RETRY_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
/** A notice this late after the slot reopened is no longer worth a turn. */
export const STALE_MS = 2 * 60 * 60 * 1000;
/** How often the bots plugin checks. */
export const TICK_MS = 30 * 1000;
const TAIL_BYTES = 256 * 1024;

export const defaultSlotsPath = (env: NodeJS.ProcessEnv = process.env) => join(stateRoot(env), "push-slots.jsonl");

export type SlotRefused = { v: 1; type: "refused"; ts: string; bot: string; at: string; retryAt: string; dm: string };
export type SlotNotice = { v: 1; type: "notice"; ts: string; bot: string; through: string; dm: string };
export type SlotSent = { v: 1; type: "notice-sent"; ts: string; bot: string; through: string; dm: string };
export type SlotSkipped = { v: 1; type: "notice-skipped"; ts: string; bot: string; through: string; reason: string };
type SlotRecord = SlotRefused | SlotNotice | SlotSent | SlotSkipped;

/** Called by bot-dm when the add-on refused a bot's push on the rate limit. Throws on I/O errors. */
export function recordRefusal(path: string, r: { bot: string; at: string; retryAt: string; dm: string }): void {
  const record: SlotRefused = { v: 1, type: "refused", ts: new Date().toISOString(), ...r };
  appendJsonl(path, record);
}

const hhmm = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

/** The DM body (bot-dm adds the envelope and the system-nudge line). */
export function slotMessage(refusals: ReadonlyArray<{ at: string }>): string {
  const last = refusals.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a));
  const when = refusals.length > 1 ? `was refused ${refusals.length} times, last at ${hhmm(last.at)}` : `was refused at ${hhmm(last.at)}`;
  return (
    `Your push slot to ${userName()} is open again (${when}). ` +
    "Nothing was queued: send it again with bot-dm user only if it still matters, else leave it in your chat. No reply needed."
  );
}

const ms = (iso: string) => Date.parse(iso);

function parse(line: string): SlotRecord | null {
  try {
    const r = JSON.parse(line);
    if (r?.v !== 1 || typeof r.bot !== "string" || typeof r.ts !== "string") return null;
    if (r.type === "refused" && Number.isFinite(ms(r.at)) && Number.isFinite(ms(r.retryAt))) return r;
    if ((r.type === "notice" || r.type === "notice-sent") && typeof r.dm === "string" && Number.isFinite(ms(r.through))) return r;
    if (r.type === "notice-skipped" && Number.isFinite(ms(r.through))) return r;
  } catch {
    // skip damaged lines
  }
  return null;
}

export interface PushSlotNotifierOptions {
  path?: string;
  send?: StallSend;
  now?: () => number;
  /** The bot's next slot from paseo-apns (`GET /status?sender=`), null when open or unknown. */
  nextSlot?: (bot: string) => Promise<string | null>;
}

export class PushSlotNotifier {
  private readonly path: string;
  private readonly send: StallSend;
  private readonly now: () => number;
  private readonly nextSlot: (bot: string) => Promise<string | null>;
  private running = false;

  constructor(options: PushSlotNotifierOptions & { send: StallSend }) {
    this.path = options.path ?? defaultSlotsPath();
    this.send = options.send;
    this.now = options.now ?? Date.now;
    this.nextSlot = options.nextSlot ?? (async () => null);
  }

  /** Sends the notices that are due. Never throws; overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch {
      // next tick
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<void> {
    const records = (await tailLines(this.path, TAIL_BYTES).catch(() => [])).map(parse).filter((r) => r !== null);
    const bots = [...new Set(records.filter((r) => r.type === "refused").map((r) => r.bot))];
    for (const bot of bots) {
      const mine = records.filter((r) => r.bot === bot);
      const closed = Math.max(-Infinity, ...mine.flatMap((r) => (r.type === "notice-sent" || r.type === "notice-skipped" ? [ms(r.through)] : [])));
      const pending = mine.filter((r): r is SlotRefused => r.type === "refused" && ms(r.at) > closed);
      if (!pending.length) continue;
      const dueAt = Math.max(...pending.map((r) => ms(r.retryAt)));
      const now = this.now();
      if (now < dueAt) continue;
      const through = pending.reduce((a, b) => (ms(b.at) > ms(a.at) ? b : a)).at;
      const skip = (reason: string) => {
        const rec: SlotSkipped = { v: 1, type: "notice-skipped", ts: new Date(now).toISOString(), bot, through, reason };
        appendJsonl(this.path, rec);
      };
      if (now - dueAt > STALE_MS) {
        skip("stale");
        continue;
      }
      const claims = mine.filter((r): r is SlotNotice => r.type === "notice" && r.through === through);
      if (claims.length >= MAX_ATTEMPTS) {
        skip("attempts");
        continue;
      }
      const last = claims.at(-1);
      if (last && now - ms(last.ts) < RETRY_MS) continue;
      const next = await this.nextSlot(bot).catch(() => null);
      if (next && ms(next) > now) {
        skip("slot-used");
        continue;
      }
      const dm = claims[0]?.dm ?? ulid(now);
      try {
        const claim: SlotNotice = { v: 1, type: "notice", ts: new Date(now).toISOString(), bot, through, dm };
        appendJsonl(this.path, claim);
      } catch {
        continue; // cannot claim: do not send (it could not be recorded as sent either)
      }
      const ok = await this.send({ to: bot, id: dm, text: slotMessage(pending) }).catch(() => false);
      if (ok) {
        try {
          const sent: SlotSent = { v: 1, type: "notice-sent", ts: new Date(this.now()).toISOString(), bot, through, dm };
          appendJsonl(this.path, sent);
        } catch {
          // the next attempt reuses the id; bot-dm reports it as a duplicate
        }
      }
    }
  }
}
