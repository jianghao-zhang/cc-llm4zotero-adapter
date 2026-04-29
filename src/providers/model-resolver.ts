/**
 * Dynamic model resolver based on available SDK models.
 * Maps frontend aliases (opus/sonnet/haiku) to actual provider models.
 * Supports hot-swapping profiles via settingSources-aware caching.
 */

export interface ModelInfo {
  value?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

const CONTEXT_SUFFIX_RE = /\[[0-9]+[km]\]$/i;
const CLAUDE_CONTEXT_ALIAS_RE = /^(opus|sonnet)\[[0-9]+[km]\]$/i;

function cleanModelName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .toLowerCase();
}

function isClaudeContextAlias(value: unknown): boolean {
  return CLAUDE_CONTEXT_ALIAS_RE.test(cleanModelName(value));
}

function normalizeModelMatchKey(value: unknown): string {
  return normalizeProviderModelName(value).replace(CONTEXT_SUFFIX_RE, "");
}

export function normalizeProviderModelName(value: unknown): string {
  const clean = cleanModelName(value);
  if (isClaudeContextAlias(clean)) return clean;
  return clean.replace(CONTEXT_SUFFIX_RE, "").trim();
}

/**
 * Cache key includes settingSources to support profile hot-swapping.
 * When user switches profiles, settingSources changes → cache miss → fresh model fetch.
 */
const modelCache = new Map<
  string,
  { models: ModelInfo[]; expiresAt: number }
>();

const CACHE_TTL_MS = 60_000; // 1 minute cache

function getCacheKey(settingSources: string[], providerKey = "default"): string {
  return `${providerKey}::${settingSources.join(",")}`;
}

export function getCachedModels(
  settingSources: string[],
  providerKey?: string,
): ModelInfo[] | undefined {
  const key = getCacheKey(settingSources, providerKey);
  const cached = modelCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.models;
  }
  return undefined;
}

export function setCachedModels(
  settingSources: string[],
  models: ModelInfo[],
  providerKey?: string,
): void {
  const key = getCacheKey(settingSources, providerKey);
  modelCache.set(key, {
    models,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Resolves frontend model alias to actual SDK model name.
 * Uses available models from SDK for dynamic matching.
 *
 * Matching strategy:
 * 1. If already a full model name, return as-is
 * 2. Single model provider: all aliases map to the only available model
 * 3. Pattern matching based on alias type (opus/sonnet/haiku)
 * 4. Substring matching
 * 5. Fallback to first available model
 */
export function resolveModelAlias(
  alias: string,
  availableModels: ModelInfo[]
): string | undefined {
  const normalizedAlias = normalizeProviderModelName(alias);
  const aliasMatchKey = normalizeModelMatchKey(alias);

  if (isClaudeContextAlias(normalizedAlias)) {
    return normalizedAlias;
  }

  // If already a full model name (contains hyphen and is long), return as-is
  if (normalizedAlias.includes("-") && normalizedAlias.length > 8) {
    return normalizedAlias;
  }

  // Extract model names from available models
  const modelEntries = availableModels
    .map((m) => {
      const model = normalizeProviderModelName(m.value);
      return model ? { model, matchKey: normalizeModelMatchKey(m.value) } : undefined;
    })
    .filter((entry): entry is { model: string; matchKey: string } => Boolean(entry));
  const modelNames = modelEntries.map((entry) => entry.model);

  if (modelNames.length === 0) {
    return undefined;
  }

  const exact = modelEntries.find((entry) => entry.model === normalizedAlias);
  if (exact) {
    return exact.model;
  }

  // Single model provider (e.g., Kimi with only k2p5): all aliases map to same model
  if (modelNames.length === 1) {
    return modelNames[0];
  }

  // Pattern matching for common aliases
  const patterns: Record<string, RegExp[]> = {
    opus: [/opus/i, /max/i, /pro/i],
    sonnet: [/sonnet/i, /k2/i, /kimi/i],
    haiku: [/haiku/i, /flash/i, /mini/i, /fast/i],
  };

  const aliasPatterns = patterns[aliasMatchKey];
  if (aliasPatterns) {
    for (const pattern of aliasPatterns) {
      for (const entry of modelEntries) {
        if (pattern.test(entry.matchKey)) {
          return entry.model;
        }
      }
    }
  }

  // Substring matching
  for (const entry of modelEntries) {
    if (entry.matchKey.includes(aliasMatchKey)) {
      return entry.model;
    }
  }

  // Reverse: check if alias is substring of any model name
  for (const entry of modelEntries) {
    if (entry.matchKey.split(/[-_.]/).some((part) => part === aliasMatchKey)) {
      return entry.model;
    }
  }

  // Fallback: return first available model
  return modelNames[0];
}

/**
 * Resolve model alias from environment variables.
 * Checks ANTHROPIC_DEFAULT_*_MODEL env vars for fallback.
 */
function resolveModelFromEnv(alias: string): string | undefined {
  const normalizedAlias = normalizeProviderModelName(alias);

  // Map aliases to env var names
  const envVarMap: Record<string, string> = {
    opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  };

  const envVarName = envVarMap[normalizedAlias];
  if (envVarName) {
    const envValue = process.env[envVarName]?.trim();
    if (envValue) return normalizeProviderModelName(envValue);
  }

  // Also check ANTHROPIC_MODEL as generic fallback
  const genericModel = process.env.ANTHROPIC_MODEL?.trim();
  if (genericModel) return normalizeProviderModelName(genericModel);

  return undefined;
}

/**
 * Synchronous resolution with cache fallback.
 * On cache miss, falls back to environment variables.
 */
export function resolveModelWithCache(
  alias: string,
  settingSources: string[],
  providerKey?: string,
): { model: string | undefined; cacheHit: boolean } {
  const normalizedAlias = normalizeProviderModelName(alias);

  if (isClaudeContextAlias(normalizedAlias)) {
    return { model: normalizedAlias, cacheHit: true };
  }

  // If already full model name, no resolution needed
  if (normalizedAlias.includes("-") && normalizedAlias.length > 8) {
    return { model: normalizedAlias, cacheHit: true };
  }

  const cached = getCachedModels(settingSources, providerKey);
  if (cached) {
    return { model: resolveModelAlias(alias, cached), cacheHit: true };
  }

  // Cache miss: try environment variables
  const envModel = resolveModelFromEnv(alias);
  if (envModel) {
    return { model: envModel, cacheHit: false };
  }

  return { model: undefined, cacheHit: false };
}
