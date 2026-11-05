/**
 * OS links for the public (DinoBot) desktop app: `<scheme>://pair/#offer=…` (the installer's
 * pairing link) and `<scheme>://provider/add?…` (a provider invite such as a private provider package's). The main
 * process only recognises them and hands the raw link to the renderer, which turns it into a route
 * with the same code the phone uses (packages/app/src/hosts/pair-deep-link.ts). macOS delivers them
 * through `open-url`; Linux and Windows through argv (first launch or a second instance).
 */

const MAX_LINK_LENGTH = 16 * 1024;

/** The link if `input` is a pairing or provider link for `scheme`, else null. */
export function readAppLink(input: string, scheme: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > MAX_LINK_LENGTH) return null;
  const prefix = `${scheme.toLowerCase()}://`;
  if (!raw.toLowerCase().startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length).replace(/^\/+/, "");
  if (/^pair\/?#offer=/i.test(rest)) return raw;
  if (/^provider\/add\/?\?/i.test(rest)) return raw;
  return null;
}

export function parseAppLinkFromArgv(argv: readonly string[], scheme: string): string | null {
  for (const arg of argv) {
    const link = readAppLink(arg, scheme);
    if (link) return link;
  }
  return null;
}

/**
 * Links waiting for a window's renderer. The renderer takes them when it has mounted its listener
 * (and again on every "open-app-link" event), so a link that arrives during start-up is not lost.
 */
export class AppLinkInbox {
  private pending: string | null = null;
  private last: { link: string; at: number } | null = null;

  /**
   * Keeps the link for the renderer. Returns false (and keeps nothing new) when the same link
   * arrived less than `windowMs` ago: macOS can deliver one launch's URL twice, which opened two
   * pairing screens. Opening the same link again on purpose (after Cancel) is seconds later.
   */
  receive(link: string, now: number, windowMs = 2_000): boolean {
    if (this.last && this.last.link === link && now - this.last.at < windowMs) return false;
    this.last = { link, at: now };
    this.pending = link;
    return true;
  }

  push(link: string): void {
    this.pending = link;
  }

  take(): string | null {
    const link = this.pending;
    this.pending = null;
    return link;
  }
}
