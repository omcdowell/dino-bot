/**
 * The user, as paseo-bots names them (host settings, passed to OptChat agents as env by the plugin):
 *   BOTS_USER_NAME     how prompts name the user (default "the user");
 *   BOTS_USER_ALIASES  comma-separated older ids that also mean the user (e.g. in old room ledgers);
 *   BOTS_ESCALATE_TO   bot that hears about escalations; empty or unset: none.
 * The user's party id in DMs and rooms is always "user".
 */
export const USER = 'user';

export const userName = (env: NodeJS.ProcessEnv = process.env) => env.BOTS_USER_NAME?.trim() || 'the user';

export const userAliases = (env: NodeJS.ProcessEnv = process.env) =>
  (env.BOTS_USER_ALIASES ?? '')
    .split(',')
    .map(a => a.trim().toLowerCase())
    .filter(a => a && a !== USER);

/** True for "user" or one of the aliases. */
export const isUser = (id: string, env: NodeJS.ProcessEnv = process.env) => {
  const lower = id.toLowerCase();
  return lower === USER || userAliases(env).includes(lower);
};

/** "user" for the user or an alias; any other id unchanged. */
export const normalizeParty = (id: string, env: NodeJS.ProcessEnv = process.env) => (isUser(id, env) ? USER : id);

export const escalateTo = (env: NodeJS.ProcessEnv = process.env) => env.BOTS_ESCALATE_TO?.trim() || null;
