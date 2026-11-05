/**
 * The model picker's Scoped view for Pi-based providers (Pi itself and custom providers that
 * extend it, such as OptChat). Scoped is Pi's `enabledModels` in its global settings.json, read and
 * curated here so the Pi TUI and Paseo share one list. Other providers report `supported: false`.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  ModelScopeError,
  addToPiScope,
  removeFromPiScope,
  resolvePiModelScope,
  type PiScopeModel,
} from "./pi-scope.js";
import { PiSettingsError, PiSettingsFile } from "./pi-settings-file.js";
import { isGlobPattern } from "./glob.js";

export interface ModelScopeView {
  provider: AgentProvider;
  supported: boolean;
  /** Pi's settings.json the scope lives in. */
  settingsPath: string | null;
  /** `enabledModels` as written ([] when unset: Pi then scopes nothing and offers every model). */
  patterns: string[];
  /** Catalogue ids in scope, in Pi's order. */
  scopedModelIds: string[];
  /** The scoped ids that come from a glob entry (e.g. `mlx-dspark-adaptive/*`). */
  globModelIds: string[];
  /** Entries that match no catalogue model (kept as they are). */
  unmatchedPatterns: string[];
}

export interface ModelScopeServiceDeps {
  getProviderBaseId(provider: AgentProvider): string | null;
  getProviderConfigEnv(provider: AgentProvider): Record<string, string> | undefined;
  /** The provider's catalogue (selectable models). */
  listModels(provider: AgentProvider): Promise<AgentModelDefinition[]>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface CatalogModel extends PiScopeModel {
  paseoId: string;
}

/** Same rule as the Pi provider: `PI_CODING_AGENT_DIR` (config env first), else `~/.pi/agent`. */
export function resolvePiSettingsPath(
  configEnv: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = configEnv?.PI_CODING_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  let dir: string;
  if (!configured) dir = join(home, ".pi", "agent");
  else if (configured === "~") dir = home;
  else if (configured.startsWith("~/")) dir = resolve(home, configured.slice(2));
  else dir = resolve(configured);
  return join(dir, "settings.json");
}

/** A Pi-provider catalogue row as the Pi model it names. */
export function toPiScopeModel(model: AgentModelDefinition): CatalogModel | null {
  const metaProvider = model.metadata?.provider;
  const metaModelId = model.metadata?.modelId;
  if (typeof metaProvider === "string" && typeof metaModelId === "string") {
    return { provider: metaProvider, id: metaModelId, name: model.label, paseoId: model.id };
  }
  const slash = model.id.indexOf("/");
  if (slash <= 0 || slash === model.id.length - 1) return null;
  return {
    provider: model.id.slice(0, slash),
    id: model.id.slice(slash + 1),
    name: model.label,
    paseoId: model.id,
  };
}

export class ModelScopeService {
  constructor(private readonly deps: ModelScopeServiceDeps) {}

  private settingsFile(provider: AgentProvider): PiSettingsFile | null {
    if (this.deps.getProviderBaseId(provider) !== "pi") return null;
    return new PiSettingsFile(
      resolvePiSettingsPath(
        this.deps.getProviderConfigEnv(provider),
        this.deps.env ?? process.env,
        this.deps.homeDir ?? homedir(),
      ),
    );
  }

  private async catalog(provider: AgentProvider): Promise<CatalogModel[]> {
    const models = await this.deps.listModels(provider);
    return models.flatMap((model) => {
      const mapped = toPiScopeModel(model);
      return mapped ? [mapped] : [];
    });
  }

  private view(
    provider: AgentProvider,
    file: PiSettingsFile,
    patterns: string[] | undefined,
    catalog: CatalogModel[],
  ): ModelScopeView {
    const list = patterns ?? [];
    const { scopedModels, diagnostics } = resolvePiModelScope(list, catalog);
    return {
      provider,
      supported: true,
      settingsPath: file.path,
      patterns: list,
      scopedModelIds: scopedModels.map((scoped) => scoped.model.paseoId),
      globModelIds: scopedModels
        .filter((scoped) => isGlobPattern(scoped.pattern))
        .map((scoped) => scoped.model.paseoId),
      unmatchedPatterns: diagnostics
        .filter((diagnostic) => diagnostic.code === "no-match")
        .map((diagnostic) => diagnostic.pattern),
    };
  }

  private unsupported(provider: AgentProvider): ModelScopeView {
    return {
      provider,
      supported: false,
      settingsPath: null,
      patterns: [],
      scopedModelIds: [],
      globModelIds: [],
      unmatchedPatterns: [],
    };
  }

  async get(provider: AgentProvider): Promise<ModelScopeView> {
    const file = this.settingsFile(provider);
    if (!file) return this.unsupported(provider);
    const [patterns, catalog] = await Promise.all([
      file.readEnabledModels(),
      this.catalog(provider),
    ]);
    return this.view(provider, file, patterns, catalog);
  }

  /** Adds `modelId` to Scoped (`scoped: true`) or removes it. */
  async set(provider: AgentProvider, modelId: string, scoped: boolean): Promise<ModelScopeView> {
    const file = this.settingsFile(provider);
    if (!file) throw new ModelScopeError(`${provider} has no model scope.`);
    const catalog = await this.catalog(provider);
    const model = catalog.find((candidate) => candidate.paseoId === modelId);
    if (!model) throw new ModelScopeError(`Model ${modelId} is not in the ${provider} catalogue.`);
    const written = await file.updateEnabledModels((current) =>
      scoped ? addToPiScope(current, model, catalog) : removeFromPiScope(current, model, catalog),
    );
    return this.view(provider, file, written, catalog);
  }
}

export { ModelScopeError, PiSettingsError };
