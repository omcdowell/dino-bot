import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { record } from './cache.ts';

/**
 * pi-web-access (third party) declares every search provider it knows, about 36, four times over (a string enum and an
 * array enum on both web_search and source_check), lists them twice more in web_search's description, and offers options
 * bots never use. OptChat slims those declarations on the wire, in the request it sends, so nothing in the package changes
 * and a `pi update` keeps the slimming. Only what the model reads changes: the tools run exactly as before, and pi still
 * validates calls against the package's full schema, so anything the slim schema allows is also allowed there.
 */

/** Parameters no bot has used (prompt-arch PR1, cut 4), by tool. `includeContent` stays: a bot has used it. */
export const UNUSED_WEB_PARAMS: Record<string, readonly string[]> = {
  web_search: ['workflow', 'proxy', 'category'],
  source_check: ['proxy'],
  fetch_content: ['forceClone', 'answerModel', 'timestamp', 'frames', 'model', 'auth', 'proxy'],
};

/** The providers bots search with when web-search.json names none: Exa (no key needed) and OpenAI (Codex sign-in). */
export const DEFAULT_SEARCH_PROVIDERS = ['exa', 'openai'] as const;

const PROVIDER_TOOLS = new Set(['web_search', 'source_check']);
const SHORT_PROVIDER_DESCRIPTION = 'Search provider, or a list searched at once. Omit to use the configured provider.';

const strings = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');

/**
 * The providers to declare: OPTCHAT_SEARCH_PROVIDERS (comma separated; `all` keeps the package's list), else the defaults
 * plus any provider web-search.json routes to. `undefined` means keep every provider.
 */
export function searchProviders(env: NodeJS.ProcessEnv = process.env, config: unknown = readWebSearchConfig(env)) {
  const override = env.OPTCHAT_SEARCH_PROVIDERS?.trim();
  if (override === 'all') return undefined;
  if (override)
    return [
      ...new Set(
        override
          .split(',')
          .map(p => p.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  const named = new Set<string>(DEFAULT_SEARCH_PROVIDERS);
  if (record(config)) {
    const webSearch = record(config.webSearch) ? config.webSearch : {};
    // An allow-list is the user's own cut: declare exactly that.
    if (Array.isArray(webSearch.allowedProviders)) return [...new Set(strings(webSearch.allowedProviders))];
    const routing = record(config.searchRouting) ? config.searchRouting : {};
    for (const p of [...strings(config.provider), ...strings(config.searchProvider), ...strings(routing.providers)])
      if (p !== 'auto' && p !== 'all') named.add(p.toLowerCase());
  }
  return [...named];
}

/** pi-web-access's own config file, where it looks without XDG_CONFIG_HOME: the agent dir, then ~/.pi. */
function readWebSearchConfig(env: NodeJS.ProcessEnv): unknown {
  const dirs = env.PI_CODING_AGENT_DIR ? [env.PI_CODING_AGENT_DIR] : [join(homedir(), '.pi', 'agent'), join(homedir(), '.pi')];
  for (const dir of dirs) {
    const file = join(dir, 'web-search.json');
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A tool's name and JSON schema in an Anthropic (`input_schema`) or OpenAI (`parameters`, `function.parameters`) request. */
function toolParts(tool: Record<string, unknown>) {
  const fn = record(tool.function) ? tool.function : undefined;
  const name = typeof tool.name === 'string' ? tool.name : typeof fn?.name === 'string' ? fn.name : undefined;
  const holder = fn ?? tool;
  const schema = record(tool.input_schema) ? tool.input_schema : record(holder.parameters) ? holder.parameters : undefined;
  return { name, schema, holder };
}

/** Keeps only `keep` (plus `auto`) in each enum branch of a provider parameter. Leaves it alone if that would empty a branch. */
function slimProviderParam(param: Record<string, unknown>, keep: Set<string>) {
  const branches = Array.isArray(param.anyOf) ? param.anyOf.filter(record) : [param];
  const enums = branches.map(b => (record(b.items) ? b.items : b)).filter(e => Array.isArray(e.enum));
  if (!enums.length) return undefined;
  const before = enums.map(e => (e.enum as unknown[]).filter((v): v is string => typeof v === 'string'));
  const after = before.map(values => values.filter(v => v === 'auto' || keep.has(v)));
  if (after.some(values => !values.some(v => v !== 'auto'))) return undefined;
  enums.forEach((e, i) => (e.enum = after[i]));
  param.description = SHORT_PROVIDER_DESCRIPTION;
  // The full provider list, in the package's order, pairs each id with its display label in the description.
  return before.reduce((a, b) => (b.length > a.length ? b : a)).filter(v => v !== 'auto' && v !== 'all');
}

/** web_search's description, without the provider lists it no longer needs and the workflow option it no longer offers. */
function slimSearchDescription(text: string, ids: string[] | undefined, keep: Set<string> | undefined) {
  let out = text;
  const lead = /^Search the web with (.+?)\. Provider arrays run simultaneously; [^]*?remain excluded\. /.exec(out);
  if (lead && ids && keep) {
    const labels = lead[1].split(', ');
    const pick = labels.length === ids.length ? ids.flatMap((id, i) => (keep.has(id) ? [labels[i]] : [])) : [...keep];
    out = `Search the web with ${pick.join(', ')}. Provider arrays run simultaneously. ${out.slice(lead[0].length)}`;
  }
  return out.replace('The default workflow is none: it returns ', 'It returns ').replace(/ Set workflow to "summary-review"[^.]*\./, '');
}

/** Slims pi-web-access's tool declarations in a provider request, in place; `providers` undefined keeps them all. Other tools pass. */
export function slimWebTools(payload: unknown, providers: readonly string[] | undefined): unknown {
  if (!record(payload) || !Array.isArray(payload.tools)) return payload;
  const keep = providers ? new Set(providers) : undefined;
  for (const tool of payload.tools) {
    if (!record(tool)) continue;
    const { name, schema, holder } = toolParts(tool);
    if (!name || !schema || !record(schema.properties)) continue;
    const props = schema.properties;
    const unused = UNUSED_WEB_PARAMS[name];
    if (!unused && !PROVIDER_TOOLS.has(name)) continue;
    for (const key of unused ?? []) delete props[key];
    let ids: string[] | undefined;
    if (keep && PROVIDER_TOOLS.has(name) && record(props.provider)) ids = slimProviderParam(props.provider, keep);
    if (name === 'web_search' && typeof holder.description === 'string')
      holder.description = slimSearchDescription(holder.description, ids, ids && keep);
  }
  return payload;
}
