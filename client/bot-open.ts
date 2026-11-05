import type { PluginOpenScreenInput, PluginSidebarItemProps } from "@getpaseo/plugin/client";

/**
 * Sidebar items get `navigation` only in our own Paseo build (feat/sidebar-navigation). The published
 * @getpaseo/plugin types do not have it yet, and the upstream app passes none, so it is optional.
 */
export interface SidebarNavigation {
  readonly openAgent: (input: { readonly agentId: string; readonly serverId?: string }) => void;
}

export type BotsSidebarItemProps = PluginSidebarItemProps & { readonly navigation?: SidebarNavigation };

export interface SidebarOpenDeps {
  navigation: SidebarNavigation | undefined;
  openScreen(input: PluginOpenScreenInput): void;
  openChat(botId: string): Promise<{ agentId: string; created: boolean }>;
  /** A new chat was made: the bots list needs a refetch for its agentId. */
  onCreated(): void;
  /** The first open is slow (the host is creating the chat): say so (openChatPatiently). */
  onStarting?(bot: { id: string; name: string }): void;
  now?: () => number;
  /** Bots whose chat is being opened; a second tap meanwhile does nothing. */
  inFlight?: Set<string>;
}

const opening = new Set<string>();

/**
 * A bot row tap. With sidebar navigation (our build) the chat opens directly: no bot screen in
 * history, so nothing can re-jump after a daemon restart or plugin reload. Without it (upstream app)
 * the bot screen opens with a nonce and jumps on (bot-screen.tsx, tap-jump.ts).
 */
export async function openBotFromSidebar(
  bot: { id: string; name: string; agentId?: string | null },
  deps: SidebarOpenDeps,
): Promise<void> {
  const { navigation } = deps;
  if (!navigation) {
    deps.openScreen({
      screenId: "bot",
      params: {
        botId: bot.id,
        name: bot.name,
        // A known chat opens with no round trip; the nonce makes the jump happen once per tap.
        ...(bot.agentId ? { agentId: bot.agentId } : {}),
        nonce: `${(deps.now ?? Date.now)()}`,
      },
    });
    return;
  }
  if (bot.agentId) {
    navigation.openAgent({ agentId: bot.agentId });
    return;
  }
  const inFlight = deps.inFlight ?? opening;
  if (inFlight.has(bot.id)) return;
  inFlight.add(bot.id);
  try {
    const result = await openChatPatiently(() => deps.openChat(bot.id), { onStarting: () => deps.onStarting?.(bot) });
    if (result.created) deps.onCreated();
    navigation.openAgent({ agentId: result.agentId });
  } catch {
    // The bot page (no nonce, so no jump) offers Open chat / New chat, which show the error.
    deps.openScreen({ screenId: "bot", params: { botId: bot.id, name: bot.name } });
  } finally {
    inFlight.delete(bot.id);
  }
}

/**
 * A bot's first open on a fresh host creates its chat (pi starts, the OptChat profile loads), which
 * can take longer than the daemon's 30 s plugin RPC limit: the app showed "Plugin RPC timed out:
 * bots.invoke" although the chat was still being made and opened fine a moment later (review video,
 * 5 Nov). The host keeps creating it after the timeout, and `bots.open` runs one at a time per bot, so
 * asking again waits for that same chat instead of making a second one.
 *
 * `openChatPatiently` asks again after a timeout (up to `retries` more times, ~2 min in all) and calls
 * `onStarting` once the open is slow (`slowMs`) or has timed out, so the screen can say "Starting
 * <bot>…" instead of a bare spinner. Any other error is thrown at once.
 */
export const OPEN_SLOW_MS = 2_500;
export const OPEN_RETRIES = 3;
export const STARTING_HINT = "the first open of a bot can take a minute";

export function isOpenTimeout(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /timed out|timeout/i.test(text);
}

export function startingLabel(name: string): string {
  return `Starting ${name}… ${STARTING_HINT}`;
}

export async function openChatPatiently<R>(
  open: () => Promise<R>,
  options: { onStarting?: () => void; retries?: number; slowMs?: number } = {},
): Promise<R> {
  const retries = options.retries ?? OPEN_RETRIES;
  let told = false;
  const starting = () => {
    if (told) return;
    told = true;
    options.onStarting?.();
  };
  const slow = setTimeout(starting, options.slowMs ?? OPEN_SLOW_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await open();
      } catch (error) {
        if (!isOpenTimeout(error) || attempt >= retries) throw error;
        starting();
      }
    }
  } finally {
    clearTimeout(slow);
  }
}
