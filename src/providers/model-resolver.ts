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
  const key = getCacheKey(settingSources);
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
  const normalizedAlias = alias.toLowerCase().trim();

  // If already a full model name (contains hyphen and is long), return as-is
  if (normalizedAlias.includes("-") && normalizedAlias.length > 8) {
    return normalizedAlias;
  }

  // Extract model names from available models
  const modelNames = availableModels
    .map((m) => m.value?.toLowerCase() || "")
    .filter(Boolean);

  if (modelNames.length === 0) {
    return undefined;
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

  const aliasPatterns = patterns[normalizedAlias];
  if (aliasPatterns) {
    for (const pattern of aliasPatterns) {
      for (const name of modelNames) {
        if (pattern.test(name)) {
          return name;
        }
      }
    }
  }

  // Substring matching
  for (const name of modelNames) {
    if (name.includes(normalizedAlias)) {
      return name;
    }
  }

  // Reverse: check if alias is substring of any model name
  for (const name of modelNames) {
    if (name.split(/[-_.]/).some((part) => part === normalizedAlias)) {
      return name;
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
  const normalizedAlias = alias.toLowerCase().trim();

  // Map aliases to env var names
  const envVarMap: Record<string, string> = {
    opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  };

  const envVarName = envVarMap[normalizedAlias];
  if (envVarName) {
    const envValue = process.env[envVarName]?.trim();
    if (envValue) return envValue.toLowerCase();
  }

  // Also check ANTHROPIC_MODEL as generic fallback
  const genericModel = process.env.ANTHROPIC_MODEL?.trim();
  if (genericModel) return genericModel.toLowerCase();

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
  const normalizedAlias = alias.toLowerCase().trim();

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
