/**
 * Per-model embedding profiles (ADR-051). Similarity scores are not comparable across
 * models, so each model's prefixes and thresholds live together and a model without a
 * profile leaves the knowledge graph off.
 */
import { createHash } from 'node:crypto';

/** What an embedding is for. A model with task prompts formats each purpose differently. */
export type EmbeddingPurpose = 'query' | 'document' | 'similarity';

export interface EmbeddingProfile {
  /** The model name the endpoint is called with. Vectors carry `embeddingStamp()`, not this. */
  model: string;
  /** Vector width stored in kg_nodes.embedding. At most HNSW_MAX_DIMENSIONS. */
  dimensions: number;
  /** Text prepended to the input for each purpose. Empty for a model without task prompts. */
  prefixes: Record<EmbeddingPurpose, string>;
  thresholds: {
    /** Cosine score at or above which a new fact merges into an existing one. */
    factDedup: number;
    /** Cosine score at or above which fuzzy entity resolution auto-resolves. */
    fuzzyResolve: number;
    /** Cosine score below which a fuzzy candidate is not surfaced as ambiguous. */
    fuzzyAmbiguityFloor: number;
  };
  /**
   * How token vectors become one sentence vector, for a model Curia runs in-process. Only
   * the bundled backend reads it; an endpoint pools on its own side. Never set from YAML:
   * an override carries its base's value, because pooling belongs to the weights.
   */
  pooling?: 'mean' | 'cls' | 'last_token';
  /**
   * sha256 (hex) of the weight file the bundled backend loaded, computed at boot by
   * `hashBundledWeights()`. Set only on the bundled path: an endpoint's weights are
   * unknown. Part of the stamp, so a weights change reads as a model mismatch.
   */
  weightsSha256?: string;
}

/** pgvector's HNSW index refuses a `vector` column wider than this (pgvector 0.8.7, HNSW_MAX_DIM). */
export const HNSW_MAX_DIMENSIONS = 2000;

export const OPENAI_TEXT_EMBEDDING_3_SMALL: EmbeddingProfile = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
  prefixes: { query: '', document: '', similarity: '' },
  thresholds: { factDedup: 0.92, fuzzyResolve: 0.90, fuzzyAmbiguityFloor: 0.75 },
};

/**
 * The two merge thresholds come from `scripts/embedding-eval.ts` on the synthetic fixture
 * in tests/fixtures/embedding-eval/. Each is the lowest at which no distinct pair in the
 * fixture merged. They were checked against a private set of 51 real name pairs, where 0.98
 * was the lowest auto-resolve threshold with no wrong merge. The ambiguity floor comes from
 * that set: about 0.70 kept 95% of real matches in the ambiguous band. The scores were
 * measured with Q8_0 weights on llama.cpp, and another quantization shifts them.
 *
 * A retrieval instruction on `similarity` was tried and stays out: it helps fact dedup but
 * hurts entity resolution, and one prefix serves both (ADR-051).
 */
export const QWEN3_EMBEDDING_4B: EmbeddingProfile = {
  model: 'Qwen3-Embedding-4B',
  dimensions: 1536,
  prefixes: {
    query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:',
    document: '',
    similarity: '',
  },
  thresholds: { factDedup: 0.94, fuzzyResolve: 0.99, fuzzyAmbiguityFloor: 0.70 },
};

/**
 * all-MiniLM-L6-v2 (Xenova's q8 ONNX export), run in-process by the bundled backend. It
 * has no task prompts, and its sentence vector is the attention-masked mean of the token
 * vectors, L2-normalised.
 *
 * Thresholds calibrated 2026-11-15 with `pnpm embedding-eval --bundled --identifier-guard`
 * on the maintainer's private labelled set (kept outside git), by ADR-051's policy:
 * `factDedup` and `fuzzyResolve` are the lowest values with no wrong merge, and the floor
 * keeps 95% of true matches at or above it.
 * - Entity resolution: 89 match / 51 distinct name pairs; the identifier guard dropped
 *   0 / 7. ROC-AUC 0.878. At 0.92, 15 of 89 true matches (0.169) auto-resolve; at the
 *   0.61 floor, 85 of 89 stay at or above it (70 in the ask band).
 * - Fact dedup: 62 merge / 63 distinct fact pairs; the guard dropped 0 / 11.
 *   ROC-AUC 0.847. At 0.95, 7 of 62 duplicates (0.113) merge.
 * Without the guard no entity threshold on the grid avoids a wrong merge, so these values
 * hold only with it on, as it is in production (identifier-guard.ts).
 */
export const ALL_MINILM_L6_V2: EmbeddingProfile = {
  model: 'all-MiniLM-L6-v2',
  dimensions: 384,
  prefixes: { query: '', document: '', similarity: '' },
  pooling: 'mean',
  thresholds: { factDedup: 0.95, fuzzyResolve: 0.92, fuzzyAmbiguityFloor: 0.61 },
};

/** The model Curia ships in its image and runs in-process when no endpoint is configured. */
export const BUNDLED_EMBEDDING_MODEL = ALL_MINILM_L6_V2.model;

export const BUILTIN_EMBEDDING_PROFILES: Readonly<Record<string, EmbeddingProfile>> = {
  [OPENAI_TEXT_EMBEDDING_3_SMALL.model]: OPENAI_TEXT_EMBEDDING_3_SMALL,
  [QWEN3_EMBEDDING_4B.model]: QWEN3_EMBEDDING_4B,
  [ALL_MINILM_L6_V2.model]: ALL_MINILM_L6_V2,
};

/**
 * Returns the profile for a model: an operator override from `embedding.profiles` first,
 * then a built-in one. Undefined means nobody has profiled the model, and the knowledge
 * graph stays off rather than run on guessed thresholds.
 */
export function lookupEmbeddingProfile(
  model: string,
  overrides: Readonly<Record<string, EmbeddingProfile>> | undefined,
): EmbeddingProfile | undefined {
  return overrides?.[model] ?? BUILTIN_EMBEDDING_PROFILES[model];
}

/**
 * The value stored in kg_nodes.embedding_model beside each vector, and the only value
 * that stored stamps are compared with. Stored vectors keep the `document` prefix they
 * were made with, so a non-empty one is part of the stamp. A changed prefix under the
 * same model name then reads as a model mismatch to the boot gate and `pnpm reembed:kg`.
 * An empty prefix leaves the stamp as the model name, which migration 103's backfill wrote.
 *
 * A bundled profile also carries the hash of the weight file it loaded, so a later image
 * shipping other weights under the same model name reads as a model mismatch too, never
 * as silent drift. Profiles without `weightsSha256` keep their existing stamp.
 */
export function embeddingStamp(profile: Pick<EmbeddingProfile, 'model' | 'prefixes' | 'weightsSha256'>): string {
  let stamp = profile.model;
  const prefix = profile.prefixes.document;
  if (prefix !== '') {
    stamp += `#document:${createHash('sha256').update(prefix).digest('hex').slice(0, 12)}`;
  }
  if (profile.weightsSha256) {
    stamp += `#weights:${profile.weightsSha256.slice(0, 12)}`;
  }
  return stamp;
}

const PURPOSES: readonly EmbeddingPurpose[] = ['query', 'document', 'similarity'];

const THRESHOLD_KEYS = {
  fact_dedup: 'factDedup',
  fuzzy_resolve: 'fuzzyResolve',
  fuzzy_ambiguity_floor: 'fuzzyAmbiguityFloor',
} as const;

/**
 * Validates `embedding.profiles` and returns profiles keyed by model name. An entry may
 * name a built-in as `base` and override fields; without a base it must give every field.
 * Throws on a malformed entry: a half-read profile would merge distinct people and facts.
 */
export function parseEmbeddingProfiles(raw: unknown, source: string): Record<string, EmbeddingProfile> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`embedding.profiles must be a mapping of model name to profile (in ${source})`);
  }

  const profiles: Record<string, EmbeddingProfile> = {};
  for (const [model, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    const at = `embedding.profiles["${model}"]`;
    if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) {
      throw new Error(`${at} must be a mapping (in ${source})`);
    }
    const entry = entryRaw as Record<string, unknown>;
    rejectUnknownKeys(entry, ['base', 'dimensions', 'prefixes', 'thresholds'], at, source);

    let base: EmbeddingProfile | undefined;
    if (entry['base'] !== undefined) {
      const baseName = entry['base'];
      if (typeof baseName !== 'string' || !BUILTIN_EMBEDDING_PROFILES[baseName]) {
        throw new Error(
          `${at}.base must name a built-in profile (${Object.keys(BUILTIN_EMBEDDING_PROFILES).join(', ')}), got: ${String(baseName)} (in ${source})`,
        );
      }
      base = BUILTIN_EMBEDDING_PROFILES[baseName];
    }

    const dimensions = entry['dimensions'] ?? base?.dimensions;
    if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > HNSW_MAX_DIMENSIONS) {
      throw new Error(`${at}.dimensions must be an integer from 1 to ${HNSW_MAX_DIMENSIONS}, got: ${String(dimensions)} (in ${source})`);
    }

    const prefixesRaw = entry['prefixes'];
    if (prefixesRaw !== undefined && (!prefixesRaw || typeof prefixesRaw !== 'object' || Array.isArray(prefixesRaw))) {
      throw new Error(`${at}.prefixes must be a mapping of query, document and similarity (in ${source})`);
    }
    const prefixesIn = (prefixesRaw ?? {}) as Record<string, unknown>;
    rejectUnknownKeys(prefixesIn, PURPOSES, `${at}.prefixes`, source);
    const prefixes = {} as Record<EmbeddingPurpose, string>;
    for (const purpose of PURPOSES) {
      // A profile with no base and no prefixes block is a model without task prompts.
      const value = prefixesIn[purpose] ?? base?.prefixes[purpose] ?? '';
      if (typeof value !== 'string') {
        throw new Error(`${at}.prefixes.${purpose} must be a string (in ${source})`);
      }
      prefixes[purpose] = value;
    }

    const thresholdsRaw = entry['thresholds'];
    if (thresholdsRaw !== undefined && (!thresholdsRaw || typeof thresholdsRaw !== 'object' || Array.isArray(thresholdsRaw))) {
      throw new Error(`${at}.thresholds must be a mapping (in ${source})`);
    }
    const thresholdsIn = (thresholdsRaw ?? {}) as Record<string, unknown>;
    rejectUnknownKeys(thresholdsIn, Object.keys(THRESHOLD_KEYS), `${at}.thresholds`, source);
    const thresholds = {} as EmbeddingProfile['thresholds'];
    for (const [yamlKey, key] of Object.entries(THRESHOLD_KEYS)) {
      const value = thresholdsIn[yamlKey] ?? base?.thresholds[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
        throw new Error(`${at}.thresholds.${yamlKey} must be a number in (0, 1], got: ${String(value)} (in ${source})`);
      }
      thresholds[key] = value;
    }
    if (thresholds.fuzzyAmbiguityFloor >= thresholds.fuzzyResolve) {
      throw new Error(`${at}.thresholds.fuzzy_ambiguity_floor must be below fuzzy_resolve (in ${source})`);
    }

    // Pooling comes only from the base: it belongs to the weights, so YAML cannot set it
    // (the unknown-key check above rejects it), and an override must not drop it.
    profiles[model] = {
      model,
      dimensions,
      prefixes,
      thresholds,
      ...(base?.pooling ? { pooling: base.pooling } : {}),
    };
  }
  return profiles;
}

// A misspelt key would otherwise fall back to the base profile's value without a word.
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, source: string): void {
  const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${at} has unknown key(s) ${unknown.join(', ')}; allowed: ${allowed.join(', ')} (in ${source})`);
  }
}
