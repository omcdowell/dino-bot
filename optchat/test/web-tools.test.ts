import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchProviders, slimWebTools, UNUSED_WEB_PARAMS } from '../src/web-tools.ts';

/** pi-web-access 0.37.0's four tools as Anthropic receives them (name, description, input_schema), captured from the package. */
type Tool = { name: string; description: string; input_schema: { properties: Record<string, any>; required?: string[] } };
const tools = (): Tool[] => JSON.parse(readFileSync(new URL('./fixtures/pi-web-access-tools.json', import.meta.url), 'utf8'));
const byName = (list: Tool[]) => Object.fromEntries(list.map(t => [t.name, t]));
const slim = (providers?: string[]) => byName((slimWebTools({ tools: tools() }, providers) as { tools: Tool[] }).tools);

test('the provider enums keep only the configured providers, plus auto', () => {
  const t = slim(['exa', 'openai']);
  for (const name of ['web_search', 'source_check']) {
    const [single, list] = t[name].input_schema.properties.provider.anyOf;
    assert.deepEqual(single.enum, ['auto', 'openai', 'exa'], `${name}: package order kept, all dropped`);
    assert.deepEqual(list.items.enum, ['openai', 'exa']);
    assert.ok(t[name].input_schema.properties.provider.description.length < 100);
  }
});

test('web_search names only the kept providers and drops the workflow sentences', () => {
  const d = slim(['exa', 'openai']).web_search.description;
  assert.match(d, /^Search the web with OpenAI, Exa\. Provider arrays run simultaneously\. It returns bounded/);
  assert.doesNotMatch(d, /Brave|Keenable|workflow|summary-review/);
  assert.match(d, /When includeContent is true/);
  assert.match(d, /omit provider unless explicitly overriding it\.$/);
});

test('unused parameters go; the ones bots use stay', () => {
  const full = byName(tools()),
    t = slim(['exa']);
  for (const [name, gone] of Object.entries(UNUSED_WEB_PARAMS)) {
    const left = Object.keys(t[name].input_schema.properties);
    for (const key of gone) assert.ok(!left.includes(key), `${name}.${key} removed`);
    assert.deepEqual(
      left,
      Object.keys(full[name].input_schema.properties).filter(k => !gone.includes(k)),
    );
  }
  assert.deepEqual(t.get_search_content, full.get_search_content, 'get_search_content is untouched');
  assert.deepEqual(Object.keys(t.web_search.input_schema.properties), [
    'query',
    'queries',
    'numResults',
    'includeContent',
    'recencyFilter',
    'domainFilter',
    'provider',
  ]);
});

test('the slim tools are much smaller and byte-stable, so the cached prefix does not churn', () => {
  const size = (v: unknown) => JSON.stringify(v).length;
  const before = size(tools()),
    after = size(Object.values(slim(['exa', 'openai'])));
  assert.ok(after < before * 0.6, `${before} -> ${after} chars`);
  assert.equal(JSON.stringify(slim(['exa', 'openai'])), JSON.stringify(slim(['exa', 'openai'])));
});

test('no provider list (all) keeps every provider but still drops unused parameters', () => {
  const full = byName(tools()),
    t = slim(undefined);
  assert.deepEqual(t.web_search.input_schema.properties.provider, full.web_search.input_schema.properties.provider);
  assert.equal(t.web_search.input_schema.properties.workflow, undefined);
  assert.match(t.web_search.description, /Keenable/);
});

test('a provider list that matches nothing leaves the enum alone rather than emptying it', () => {
  const full = byName(tools()),
    t = slim(['nosuch']);
  assert.deepEqual(t.source_check.input_schema.properties.provider, full.source_check.input_schema.properties.provider);
});

test('OpenAI-shaped tool lists are slimmed too; other tools and payloads pass through', () => {
  const openai = {
    tools: tools().map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
  };
  const out = slimWebTools(openai, ['exa']) as any;
  assert.equal(out.tools[0].function.parameters.properties.workflow, undefined);
  assert.deepEqual(out.tools[0].function.parameters.properties.provider.anyOf[1].items.enum, ['exa']);
  const other = { tools: [{ name: 'bash', description: 'x', input_schema: { type: 'object', properties: { proxy: {} } } }] };
  assert.deepEqual(slimWebTools(structuredClone(other), ['exa']), other);
  assert.equal(slimWebTools('text', ['exa']), 'text');
});

test('providers: defaults, web-search.json routing, its allow-list, and the env override', () => {
  assert.deepEqual(searchProviders({}, undefined), ['exa', 'openai']);
  assert.deepEqual(searchProviders({}, { provider: 'brave', searchRouting: { providers: ['tavily', 'auto'] } }), [
    'exa',
    'openai',
    'brave',
    'tavily',
  ]);
  assert.deepEqual(searchProviders({}, { webSearch: { allowedProviders: ['kagi'] } }), ['kagi']);
  assert.deepEqual(searchProviders({ OPTCHAT_SEARCH_PROVIDERS: ' Exa, perplexity ' }, undefined), ['exa', 'perplexity']);
  assert.equal(searchProviders({ OPTCHAT_SEARCH_PROVIDERS: 'all' }, undefined), undefined);
});
