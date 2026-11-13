// Adding a provider plugin from the app (the bots plugin's provider.* RPCs call this inside the
// daemon, through phone-signin.mjs createOnboarding). Same code path as `dinobot provider add`
// (providers.mjs addProvider: `pi install` into DinoBot's pi dir, the token kept 0600 in
// secrets/git-tokens.json, never in a URL, a command line or a log), then pi is asked which
// providers the new package registers (provider-overrides.mjs) and the model catalog is refreshed,
// so the app can go straight on to the sign-in that provider needs.
//
// The phone is a remote caller, so it gets less than the terminal: no folders (only npm:<pkg> and
// git:github.com/<owner>/<repo>@<tag>), a git source must name a tag/ref, one install at a time,
// and nothing it gets back ever carries the token (errors are scrubbed too).
import { randomUUID } from "node:crypto";
import { addProvider as defaultAddProvider, listProviders, parseSource, removeProvider as defaultRemoveProvider } from "./providers.mjs";

/** Token shapes scrubbed from any text sent back, besides the request's own token. */
const TOKEN_PATTERNS = [/github_pat_[\w-]+/g, /\bgh[pousr]_[A-Za-z0-9_]{10,}/g];

export function scrub(text, token = null) {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("***");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "***");
  return out;
}

const NAME_MAX = 80;

/**
 * What the app may ask for: -> {source, token, name, parsed}. Throws a message fit to show (never
 * containing the token).
 */
export function validateInstallRequest(input = {}) {
  const parsed = parseSource(input.source);
  if (parsed.kind === "local") throw new Error("From the app, only npm:<package> and git:github.com/<owner>/<repo>@<tag> can be added. Add a folder from the computer: dinobot provider add <folder>.");
  if (parsed.kind === "git") {
    if (parsed.host.toLowerCase() !== "github.com") throw new Error("From the app, git sources must be on github.com.");
    if (!parsed.pinned) throw new Error("This link names no version (git:github.com/<owner>/<repo>@<tag>). Ask the person who sent it for a new link.");
  }
  const token = typeof input.token === "string" && input.token.trim() ? input.token.trim() : null;
  if (token && parsed.kind !== "git") throw new Error("A token only goes with a git source.");
  if (token && !/^[\w-]{20,255}$/.test(token)) throw new Error("That token does not look right.");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, NAME_MAX) : null;
  return { source: parsed.source, token, name, parsed };
}

/** Does an extension at `extensionPath` belong to the package `parsed` (pi's install layout)? */
export function fromPackage(extensionPath, parsed) {
  const p = String(extensionPath ?? "").replace(/\\/g, "/").toLowerCase();
  if (!p) return false;
  if (parsed.kind === "git") return p.includes(`/${parsed.repoKey}/`);
  if (parsed.kind === "npm") {
    const pkg = parsed.source.slice(4).replace(/(.)@.*$/, "$1").toLowerCase();
    return p.includes(`/node_modules/${pkg}/`);
  }
  return false;
}

/** The sign-in option that makes `provider` ready: a login first (plans), else an API key. */
export function signInOptionFor(options, provider, authType = null) {
  const same = options.filter((o) => o.provider === provider);
  if (authType === "api_key") return same.find((o) => o.method === "api-key") ?? same[0] ?? null;
  return same.find((o) => o.method !== "api-key") ?? same[0] ?? null;
}

/**
 * Install jobs and the provider list for the app. `deps` (all injectable for tests):
 *   addProvider, removeProvider, listPackages() -> [{source, bundled}],
 *   overrides({fresh}) -> [{provider, plugin, extensionPath}], signInOptions() -> [{id, provider, method, label}],
 *   authCheck(provider) -> {status}, authTypes() -> {provider: "oauth"|"api_key"}, refreshCatalog()
 */
export class ProviderJobs {
  constructor(L, deps = {}) {
    this.L = L;
    this.deps = {
      addProvider: (req) => defaultAddProvider(L, req),
      removeProvider: (source) => defaultRemoveProvider(L, source),
      listPackages: () => listProviders(L, []),
      overrides: async () => [],
      signInOptions: async () => [],
      authCheck: async () => ({ status: "not_ready" }),
      authTypes: () => ({}),
      refreshCatalog: async () => ({ ok: true }),
      ...deps,
    };
    this.jobs = new Map();
    this.running = null;
  }

  /** Starts an install; the app polls status(). Throws (scrubbed) on a bad request. */
  install(input) {
    let req;
    try {
      req = validateInstallRequest(input);
    } catch (e) {
      throw new Error(scrub(e.message, input?.token));
    }
    if (this.running) throw new Error("Another provider is being added on this computer. Wait for it to finish.");
    const job = { jobId: randomUUID(), source: req.source, name: req.name, state: "running", step: "installing", error: null, providers: [], startedAt: Date.now() };
    this.jobs.set(job.jobId, job);
    this.running = job.jobId;
    job.done = this.run(job, req).finally(() => {
      if (this.running === job.jobId) this.running = null;
    });
    return this.status({ jobId: job.jobId });
  }

  /** Resolves when the job has finished (tests; the app polls status()). */
  async wait(jobId) {
    await this.jobs.get(jobId)?.done;
    return this.status({ jobId });
  }

  async run(job, req) {
    try {
      await this.deps.addProvider({ source: req.source, token: req.token });
      job.step = "checking";
      const overrides = await Promise.resolve(this.deps.overrides({ fresh: true })).catch(() => []);
      const mine = overrides.filter((o) => fromPackage(o.extensionPath, req.parsed));
      job.step = "models";
      await Promise.resolve(this.deps.refreshCatalog()).catch(() => null);
      job.providers = await this.providerRows(mine.map((o) => ({ provider: o.provider, plugin: o.plugin })));
      job.step = "done";
      job.state = "done";
    } catch (e) {
      job.state = "error";
      job.error = scrub(e?.message ?? String(e), req.token);
    } finally {
      req.token = null;
    }
  }

  status({ jobId }) {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error("Unknown install.");
    return { jobId: j.jobId, source: j.source, name: j.name, state: j.state, step: j.step, error: j.error, providers: j.providers };
  }

  /** [{provider, plugin|null, ready, optionId|null, label}] for the given providers. */
  async providerRows(list) {
    const options = await Promise.resolve(this.deps.signInOptions()).catch(() => []);
    const types = this.deps.authTypes() ?? {};
    const rows = [];
    for (const { provider, plugin = null } of list) {
      const check = await Promise.resolve(this.deps.authCheck(provider)).catch(() => ({ status: "not_ready" }));
      const option = signInOptionFor(options, provider, types[provider] ?? null);
      rows.push({ provider, plugin, ready: check?.status === "ready", optionId: option?.id ?? null, label: option?.label ?? provider });
    }
    return rows;
  }

  /**
   * Settings → Providers: the packages added, and the providers that matter here: every one with
   * a sign-in in DinoBot's auth.json (ready or expired) plus every one an added package registers.
   */
  async list() {
    const packages = (this.deps.listPackages() ?? []).map((p) => ({ source: p.source, bundled: Boolean(p.bundled) }));
    const overrides = await Promise.resolve(this.deps.overrides({ fresh: false })).catch(() => []);
    const seen = new Map();
    for (const provider of Object.keys(this.deps.authTypes() ?? {})) seen.set(provider, { provider, plugin: null });
    for (const o of overrides) seen.set(o.provider, { provider: o.provider, plugin: o.plugin ?? null });
    return { packages, providers: await this.providerRows([...seen.values()]) };
  }

  async remove({ source }) {
    const parsed = parseSource(source);
    const same = (s) => {
      try {
        return parseSource(s).source === parsed.source;
      } catch {
        return false;
      }
    };
    const pkg = (this.deps.listPackages() ?? []).find((p) => same(p.source));
    if (!pkg) throw new Error(`${parsed.source} is not added on this computer.`);
    if (pkg.bundled) throw new Error(`${parsed.source} comes with the app and stays.`);
    if (this.running) throw new Error("A provider is being added on this computer. Wait for it to finish.");
    const r = await this.deps.removeProvider(parsed.source);
    await Promise.resolve(this.deps.overrides({ fresh: true })).catch(() => []);
    return { removed: r.removed };
  }
}
