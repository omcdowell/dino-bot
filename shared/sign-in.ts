/**
 * Model sign-in options the public build offers (setup wizard and the app's Models screen).
 * Each maps to a pi-ai login (`@earendil-works/pi-ai` oauth or an API key in pi's auth.json).
 *
 * Private provider packages are not part of the public build; they are added per person as
 * provider plugins (`dinobot provider add`). Claude sign-in is Anthropic's own OAuth, which
 * Anthropic bills as extra usage outside its apps; the label, badge and a confirm step say so,
 * and it is listed last.
 */
export type SignInMethod = "api-key" | "device-code" | "paste-code";

export type SignInOption = {
  /** pi provider id (auth.json key). */
  provider: string;
  label: string;
  method: SignInMethod;
  /** One line under the label. */
  note?: string;
  /** Short badge next to the label (app list, settings row, status). */
  badge?: string;
  /**
   * Shown before the login starts, and the user must confirm it (setup: "Continue? (y/N)"; app:
   * a sheet with "Continue with Claude" / "Choose another"). Never skipped by a default.
   */
  confirm?: { title: string; body: string; ok: string };
};

/**
 * Claude login wording (Q4, 27 Oct: label it clearly as EXTRA USAGE). Matches pi's own
 * warning ("Third-party harness usage draws from extra usage and is billed per token, not your
 * Claude plan limits"). One place: the setup wizard and the app both read it from here.
 *
 * 27 Oct (licence answers, item 4): also warn that the experience may be sub-par, and
 * recommend subscriptions that allow direct API use instead.
 */
export const CLAUDE_EXTRA_USAGE = {
  label: "Claude login (extra usage)",
  badge: "EXTRA USAGE",
  note: "Billed to your Claude extra usage, per token. Not your Pro/Max plan's included usage.",
  confirm: {
    title: "Claude login uses EXTRA USAGE",
    body:
      "Anthropic bills third-party apps like this one to your Claude account's extra usage, per token, on top of your subscription. " +
      "Your Pro/Max plan's included usage is not used. Turn on extra usage and set a monthly limit first at claude.ai/settings/usage. " +
      "The experience may also be sub-par: Claude subscriptions are built for Anthropic's own apps, not for tools like this one. " +
      "We recommend a Codex, Muse, Grok, OpenCode, GLM or DeepSeek subscription instead: they allow direct API use.",
    ok: "Continue with Claude",
  },
} as const;

/**
 * Claude login wording when a provider plugin on this computer replaces pi's own "anthropic"
 * provider (added with `dinobot provider add`). Such a plugin can send Claude requests so they use
 * the Claude plan's included usage, so EXTRA USAGE would be wrong; it is unofficial instead.
 *
 * The host detects this generically (any added plugin that registers the "anthropic" provider,
 * read from pi itself) and passes the plugin's own display name, so no plugin is named in the
 * public build. 27 Oct (fr-app Q3): "Uses your Claude plan through <plugin> (unofficial;
 * Anthropic's terms risk)". Still listed last, still never pre-selected, still confirmed.
 */
export function claudeViaPlugin(plugin: string): Required<Pick<SignInOption, "label" | "note" | "badge" | "confirm">> {
  return {
    label: `Claude login (your plan, via ${plugin})`,
    badge: "UNOFFICIAL",
    note: `Uses your Claude plan through ${plugin} (unofficial; Anthropic's terms risk).`,
    confirm: {
      title: `Claude login through ${plugin}`,
      body:
        `${plugin}, a provider plugin added on this computer, replaces the Claude connection, so your bots use your Claude Pro/Max plan's included usage, not extra usage. ` +
        `It is unofficial and not supported by Anthropic: using a Claude plan outside Anthropic's own apps may break Anthropic's terms, and Anthropic could limit or close your account. ` +
        "Only continue if you accept that risk. Supported instead: a Codex, Muse, Grok, OpenCode, GLM or DeepSeek subscription, or an API key.",
      ok: "Continue with Claude",
    },
  };
}

export const SIGN_IN_OPTIONS: readonly SignInOption[] = [
  { provider: "openai-codex", label: "ChatGPT (Codex)", method: "device-code", note: "Uses your ChatGPT plan" },
  { provider: "github-copilot", label: "GitHub Copilot", method: "device-code", note: "Uses your Copilot plan" },
  { provider: "openrouter", label: "OpenRouter", method: "api-key", note: "Pay per use, many models" },
  { provider: "anthropic", label: "Anthropic API key", method: "api-key", note: "Pay per use" },
  { provider: "openai", label: "OpenAI API key", method: "api-key", note: "Pay per use" },
  // Last on purpose (rel-flow Q4): it costs extra on top of a plan the user already pays for.
  {
    provider: "anthropic",
    label: CLAUDE_EXTRA_USAGE.label,
    method: "paste-code",
    note: CLAUDE_EXTRA_USAGE.note,
    badge: CLAUDE_EXTRA_USAGE.badge,
    confirm: { ...CLAUDE_EXTRA_USAGE.confirm },
  },
];
