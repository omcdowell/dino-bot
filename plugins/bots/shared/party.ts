/**
 * The user as a party in DMs and group rooms.
 *
 * The id is fixed ("user"); how bots name the user is a setting (server/settings.ts). Aliases
 * (e.g. an id older ledgers used) are set once by the server or CLI at start and read as USER
 * wherever a ledger line, envelope or CLI argument names a party.
 *
 * Imports nothing, so it runs in the client bundle too (where no aliases are set).
 */
export const USER = "user";

let aliases: ReadonlySet<string> = new Set();

/** Ids that also mean the user (lower case). USER itself is always one. */
export function setUserAliases(list: readonly string[]): void {
  aliases = new Set(list.map((a) => a.toLowerCase()).filter((a) => a !== USER));
}

export function userAliases(): string[] {
  return [...aliases];
}

export function isUserParty(party: string): boolean {
  const p = party.toLowerCase();
  return p === USER || aliases.has(p);
}

/** USER for the user or an alias; any other party unchanged. */
export function normalizeParty(party: string): string {
  return isUserParty(party) ? USER : party;
}

/** Copy of a record with `from`/`to` normalized (same object when nothing changes). */
export function normalizeParties<T extends { from?: unknown; to?: unknown }>(record: T): T {
  const from = typeof record.from === "string" ? normalizeParty(record.from) : record.from;
  const to = typeof record.to === "string" ? normalizeParty(record.to) : record.to;
  return from === record.from && to === record.to ? record : { ...record, from, to };
}

let name = "the user";

/** How bots and prompts name the user (setting `user.name`; default "the user"). */
export function setUserName(value: string): void {
  name = value.trim() || "the user";
}

export function userName(): string {
  return name;
}
