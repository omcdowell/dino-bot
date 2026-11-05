/**
 * Pi's `enabledModels` scope, ported from pi-coding-agent `core/model-resolver.js`
 * (`resolveModelScopeFromModels`, `parseModelPattern`, `findExactModelReferenceMatch`). The daemon
 * runs Pi as a separate binary and does not depend on its package, and Pi exports this logic only
 * behind its own model runtime, so the matching is kept line for line here. Each scoped model also
 * records the pattern that brought it in, which the curating writes need.
 */
import { isGlobPattern, matchesGlob } from "./glob.js";

export interface PiScopeModel {
  /** Pi provider id, e.g. "openrouter". */
  provider: string;
  /** Pi model id, e.g. "z-ai/glm-5.3". */
  id: string;
  name?: string;
}

export interface PiScopedModel<M extends PiScopeModel = PiScopeModel> {
  model: M;
  thinkingLevel?: string;
  /** The `enabledModels` entry that first matched this model. */
  pattern: string;
}

export interface PiScopeDiagnostic {
  code: "no-match" | "invalid-thinking-level";
  message: string;
  pattern: string;
}

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isValidPiThinkingLevel(level: string): boolean {
  return VALID_THINKING_LEVELS.has(level);
}

export function piModelReference(model: PiScopeModel): string {
  return `${model.provider}/${model.id}`;
}

function sameModel(a: PiScopeModel, b: PiScopeModel): boolean {
  return a.provider === b.provider && a.id === b.id;
}

/** Pi: an id without a `-YYYYMMDD` date suffix (or ending in `-latest`) is an alias. */
function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

export function findExactModelReferenceMatch<M extends PiScopeModel>(
  modelReference: string,
  availableModels: readonly M[],
): M | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;
  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => piModelReference(model).toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;
  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }
  const idMatches = availableModels.filter(
    (model) => model.id.toLowerCase() === normalizedReference,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function tryMatchModel<M extends PiScopeModel>(
  modelPattern: string,
  availableModels: readonly M[],
): M | undefined {
  const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
  if (exactMatch) return exactMatch;
  const lowered = modelPattern.toLowerCase();
  const matches = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(lowered) || model.name?.toLowerCase().includes(lowered),
  );
  if (matches.length === 0) return undefined;
  const aliases = matches.filter((model) => isAlias(model.id));
  const datedVersions = matches.filter((model) => !isAlias(model.id));
  if (aliases.length > 0) {
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }
  datedVersions.sort((a, b) => b.id.localeCompare(a.id));
  return datedVersions[0];
}

export function parsePiModelPattern<M extends PiScopeModel>(
  pattern: string,
  availableModels: readonly M[],
): { model: M | undefined; thinkingLevel: string | undefined; warning: string | undefined } {
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1)
    return { model: undefined, thinkingLevel: undefined, warning: undefined };
  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);
  const result = parsePiModelPattern(prefix, availableModels);
  if (isValidPiThinkingLevel(suffix)) {
    if (result.model) {
      return {
        model: result.model,
        thinkingLevel: result.warning ? undefined : suffix,
        warning: result.warning,
      };
    }
    return result;
  }
  if (result.model) {
    return {
      model: result.model,
      thinkingLevel: undefined,
      warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
    };
  }
  return result;
}

/** Splits a glob's optional `:level` suffix (`provider/*:high`). */
export function splitGlobThinkingLevel(pattern: string): {
  globPattern: string;
  thinkingLevel: string | undefined;
} {
  const colonIdx = pattern.lastIndexOf(":");
  if (colonIdx !== -1) {
    const suffix = pattern.substring(colonIdx + 1);
    if (isValidPiThinkingLevel(suffix)) {
      return { globPattern: pattern.substring(0, colonIdx), thinkingLevel: suffix };
    }
  }
  return { globPattern: pattern, thinkingLevel: undefined };
}

/** Models a glob entry matches, as Pi resolves it. */
export function matchPiGlob<M extends PiScopeModel>(
  globPattern: string,
  availableModels: readonly M[],
): M[] {
  const exactMatch = findExactModelReferenceMatch(globPattern, availableModels);
  if (exactMatch) return [exactMatch];
  return availableModels.filter(
    (model) =>
      matchesGlob(piModelReference(model), globPattern) || matchesGlob(model.id, globPattern),
  );
}

export function resolvePiModelScope<M extends PiScopeModel>(
  patterns: readonly string[],
  models: readonly M[],
): { scopedModels: PiScopedModel<M>[]; diagnostics: PiScopeDiagnostic[] } {
  const scopedModels: PiScopedModel<M>[] = [];
  const diagnostics: PiScopeDiagnostic[] = [];
  const push = (model: M, thinkingLevel: string | undefined, pattern: string) => {
    if (!scopedModels.some((scoped) => sameModel(scoped.model, model))) {
      scopedModels.push({ model, pattern, ...(thinkingLevel ? { thinkingLevel } : {}) });
    }
  };
  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) {
      const { globPattern, thinkingLevel } = splitGlobThinkingLevel(pattern);
      const matching = matchPiGlob(globPattern, models);
      if (matching.length === 0) {
        diagnostics.push({
          code: "no-match",
          message: `No models match pattern "${pattern}"`,
          pattern,
        });
        continue;
      }
      for (const model of matching) push(model, thinkingLevel, pattern);
      continue;
    }
    const { model, thinkingLevel, warning } = parsePiModelPattern(pattern, models);
    if (warning) diagnostics.push({ code: "invalid-thinking-level", message: warning, pattern });
    if (!model) {
      diagnostics.push({
        code: "no-match",
        message: `No models match pattern "${pattern}"`,
        pattern,
      });
      continue;
    }
    push(model, thinkingLevel, pattern);
  }
  return { scopedModels, diagnostics };
}

export class ModelScopeError extends Error {}

/**
 * `enabledModels` with `model` added. A model already in scope leaves the list as it is; otherwise
 * its exact `provider/id` reference is appended (globs are never rewritten).
 */
export function addToPiScope<M extends PiScopeModel>(
  patterns: readonly string[] | undefined,
  model: M,
  models: readonly M[],
): string[] {
  const current = [...(patterns ?? [])];
  if (current.length > 0) {
    const { scopedModels } = resolvePiModelScope(current, models);
    if (scopedModels.some((scoped) => sameModel(scoped.model, model))) return current;
  }
  return [...current, piModelReference(model)];
}

/**
 * `enabledModels` without `model`. Exact entries that resolve to it are dropped. A glob that
 * matches it is replaced by exact references to its other matches (keeping its `:level`), which
 * is what Pi's own `/scoped-models` does when it saves. Removing the last model is refused,
 * because an empty list means "every model" to Pi.
 */
export function removeFromPiScope<M extends PiScopeModel>(
  patterns: readonly string[] | undefined,
  model: M,
  models: readonly M[],
): string[] {
  const current = [...(patterns ?? [])];
  if (current.length === 0) {
    throw new ModelScopeError(
      "Scoped is empty (Pi shows every model), so there is nothing to remove.",
    );
  }
  const next: string[] = [];
  for (const pattern of current) {
    if (isGlobPattern(pattern)) {
      const { globPattern, thinkingLevel } = splitGlobThinkingLevel(pattern);
      const matching = matchPiGlob(globPattern, models);
      if (!matching.some((candidate) => sameModel(candidate, model))) {
        next.push(pattern);
        continue;
      }
      for (const other of matching) {
        if (sameModel(other, model)) continue;
        const reference = piModelReference(other) + (thinkingLevel ? `:${thinkingLevel}` : "");
        if (!next.includes(reference)) next.push(reference);
      }
      continue;
    }
    const { model: resolved } = parsePiModelPattern(pattern, models);
    if (resolved && sameModel(resolved, model)) continue;
    next.push(pattern);
  }
  const remaining = resolvePiModelScope(next, models).scopedModels;
  if (remaining.length === 0) {
    throw new ModelScopeError("Keep at least one model in Scoped.");
  }
  return next;
}
