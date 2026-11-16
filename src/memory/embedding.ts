import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import { createEmbeddingCall, createEmbeddingError } from '../bus/events.js';
import { hashBundledWeights, OnnxEmbeddingBackend } from './embedding-onnx.js';
import {
  BUNDLED_EMBEDDING_MODEL,
  lookupEmbeddingProfile,
  OPENAI_TEXT_EMBEDDING_3_SMALL,
  type EmbeddingProfile,
  type EmbeddingPurpose,
} from './embedding-profiles.js';

/**
 * OpenAI's API, used without configuration only by the deprecated compatibility rule in
 * `resolveEmbedding()`. Configured explicitly, OpenAI is an ordinary endpoint.
 */
export const OPENAI_EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
// A local server that is busy or still loading its model can hold a request open, and a
// knowledge-graph write waits on this call.
export const EMBEDDING_FETCH_TIMEOUT_MS = 30_000;

/**
 * An OpenAI-compatible /embeddings endpoint: OpenAI itself, llama.cpp, Ollama, vLLM,
 * text-embeddings-inference or anything else that speaks the API.
 */
export interface EmbeddingEndpoint {
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token. Undefined for a local server that takes no key. */
  apiKey: string | undefined;
}

/** `url` without any `user:password@` part, for a log line. */
export function redactUrlUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
}

/** The settings resolution reads. A subset of `Config`, so tests can pass just these. */
export interface EmbeddingConfig {
  embeddingBaseUrl: string | undefined;
  embeddingModel: string | undefined;
  /** Vault `embedding_api_key`: the key for a configured endpoint, OpenAI included. */
  embeddingApiKey: string | undefined;
  /** Vault `openai_api_key`: read for embeddings only by the deprecated compatibility rule. */
  openaiApiKey: string | undefined;
  /** Where the bundled model's files are (`EMBEDDING_MODEL_DIR`). */
  embeddingModelDir: string;
}

/**
 * What the knowledge graph already holds, which decides whether resolution may pick the
 * bundled model (design §1). Built from the boot gate's snapshot (`storedStateFromSnapshot`)
 * so resolution and the gate read the table once.
 */
export interface StoredEmbeddingState {
  /** The stamps of the stored vectors (`embeddingStamp()` of the profile that made each). */
  stamps: string[];
  /** The target stamp of an unfinished `pnpm reembed:kg` run, if one is recorded. */
  openRunTarget?: string;
}

/** The model a stamp names: the part before the first `#` (`embeddingStamp()` appends the rest). */
export function stampModel(stamp: string): string {
  const hash = stamp.indexOf('#');
  return hash === -1 ? stamp : stamp.slice(0, hash);
}

export type EmbeddingResolution =
  | { ok: true; source: EmbeddingSource; profile: EmbeddingProfile; deprecation?: 'implicit_openai' }
  | { ok: false; reason: 'no_model' }
  | { ok: false; reason: 'no_profile'; model: string }
  | { ok: false; reason: 'non_bundled_model_without_base_url'; model: string }
  | { ok: false; reason: 'stored_model_without_endpoint'; storedModel: string }
  | { ok: false; reason: 'implicit_openai_without_key' };

export type EmbeddingResolutionFailure = Exclude<EmbeddingResolution, { ok: true }>;

/**
 * The one place that decides where embeddings come from (design §1): no
 * `EMBEDDING_BASE_URL` means the bundled in-process model, a base URL means that server,
 * OpenAI included. Pure over `stored`, so every construction site resolves the same way.
 *
 * An install whose graph holds another model's vectors (or whose unfinished re-embed
 * targets one) is never switched to the bundled model unless `EMBEDDING_MODEL` names it:
 * that is the operator's switch signal, and the boot gate then holds the knowledge graph
 * off until `pnpm reembed:kg` runs.
 */
export function resolveEmbedding(
  config: EmbeddingConfig,
  profileOverrides: Readonly<Record<string, EmbeddingProfile>> | undefined,
  stored: StoredEmbeddingState,
): EmbeddingResolution {
  // 1. A base URL: that server and EMBEDDING_MODEL's profile, whoever runs it. There is no
  // default model: a server that ignores the model field (llama.cpp does) would answer
  // under another model's name, and its vectors would pass as that model's.
  if (config.embeddingBaseUrl) {
    const model = config.embeddingModel;
    if (!model) return { ok: false, reason: 'no_model' };
    // A built-in or YAML profile never carries weightsSha256 (only the bundled path sets
    // it, after hashing), so a model served by an endpoint stamps as its bare name (§3).
    const profile = lookupEmbeddingProfile(model, profileOverrides);
    if (!profile) return { ok: false, reason: 'no_profile', model };
    return {
      ok: true,
      source: {
        kind: 'endpoint',
        endpoint: { baseUrl: config.embeddingBaseUrl.replace(/\/+$/, ''), model, apiKey: config.embeddingApiKey },
      },
      profile,
    };
  }

  // 2. No base URL: the bundled model, unless the graph already belongs to another model.
  const explicit = config.embeddingModel;
  if (explicit === BUNDLED_EMBEDDING_MODEL) return bundled(config, profileOverrides);
  // #2225 allowed naming OpenAI's model without a base URL, so that name alone still
  // reaches the compatibility rule below; any other non-bundled name needs a base URL.
  if (explicit !== undefined && explicit !== OPENAI_TEXT_EMBEDDING_3_SMALL.model) {
    return { ok: false, reason: 'non_bundled_model_without_base_url', model: explicit };
  }

  // An unfinished run's target counts too: a re-embed that stopped after clearing
  // vectors must not leave the install looking fresh and switch it silently.
  const storedModels = new Set(
    [...stored.stamps, ...(stored.openRunTarget !== undefined ? [stored.openRunTarget] : [])].map(stampModel),
  );
  storedModels.delete(BUNDLED_EMBEDDING_MODEL);
  if (storedModels.size === 0) {
    // A fresh install or empty graph gets OpenAI only through step 1, key or no key.
    if (explicit !== undefined) return { ok: false, reason: 'non_bundled_model_without_base_url', model: explicit };
    return bundled(config, profileOverrides);
  }

  // The graph holds a model other than OpenAI's (alone or beside OpenAI's): its endpoint
  // settings are gone. Sorted, so a mixed graph names the same model on every boot.
  const notOpenAI = [...storedModels].filter(m => m !== OPENAI_TEXT_EMBEDDING_3_SMALL.model).sort();
  if (notOpenAI.length > 0) return { ok: false, reason: 'stored_model_without_endpoint', storedModel: notOpenAI[0]! };

  // TODO(#2628): remove the implicit OpenAI compatibility rule (phase-out after #2023)
  // Before the bundled model, no base URL plus an openai_api_key meant OpenAI. An install
  // whose graph holds OpenAI vectors keeps that, deprecated, so nobody's model changes
  // under them on upgrade. The only place openai_api_key is read for embeddings.
  if (!config.openaiApiKey) return { ok: false, reason: 'implicit_openai_without_key' };
  const profile = lookupEmbeddingProfile(OPENAI_TEXT_EMBEDDING_3_SMALL.model, profileOverrides);
  if (!profile) return { ok: false, reason: 'no_profile', model: OPENAI_TEXT_EMBEDDING_3_SMALL.model };
  return {
    ok: true,
    source: {
      kind: 'endpoint',
      endpoint: { baseUrl: OPENAI_EMBEDDING_BASE_URL, model: OPENAI_TEXT_EMBEDDING_3_SMALL.model, apiKey: config.openaiApiKey },
    },
    profile,
    deprecation: 'implicit_openai',
  };
}

/** The bundled model's resolution. Its profile gains `weightsSha256` once the weights are hashed. */
function bundled(
  config: EmbeddingConfig,
  profileOverrides: Readonly<Record<string, EmbeddingProfile>> | undefined,
): EmbeddingResolution {
  const profile = lookupEmbeddingProfile(BUNDLED_EMBEDDING_MODEL, profileOverrides);
  if (!profile) return { ok: false, reason: 'no_profile', model: BUNDLED_EMBEDDING_MODEL };
  return { ok: true, source: { kind: 'bundled', modelDir: config.embeddingModelDir }, profile };
}

const SWITCH_TO_BUNDLED = `set EMBEDDING_MODEL=${BUNDLED_EMBEDDING_MODEL} and run pnpm reembed:kg`;
const EXPLICIT_OPENAI =
  `EMBEDDING_BASE_URL=${OPENAI_EMBEDDING_BASE_URL}, EMBEDDING_MODEL=${OPENAI_TEXT_EMBEDDING_3_SMALL.model} ` +
  'and the key in the vault as embedding_api_key';

/** One log line explaining why the knowledge graph is off, for a failed resolution. Each names the fix. */
export function describeEmbeddingUnavailable(resolution: EmbeddingResolutionFailure): string {
  switch (resolution.reason) {
    case 'no_model':
      return 'EMBEDDING_BASE_URL is set but EMBEDDING_MODEL is not. Set EMBEDDING_MODEL to the model the server runs, which must have an embedding profile';
    case 'no_profile':
      return `No embedding profile for model "${resolution.model}". Add one under embedding.profiles in config/local.yaml (dimensions, prefixes, thresholds) to enable it`;
    case 'non_bundled_model_without_base_url':
      return `EMBEDDING_MODEL is "${resolution.model}" but EMBEDDING_BASE_URL is not set, and a non-bundled model needs EMBEDDING_BASE_URL. ` +
        `Set EMBEDDING_BASE_URL to the server that runs it, or unset EMBEDDING_MODEL to use the bundled model (${BUNDLED_EMBEDDING_MODEL})`;
    case 'stored_model_without_endpoint':
      return `The knowledge graph holds vectors made by ${resolution.storedModel}, and no endpoint is configured for it. ` +
        `To keep it, restore EMBEDDING_BASE_URL/EMBEDDING_MODEL for ${resolution.storedModel}, or ${SWITCH_TO_BUNDLED}`;
    case 'implicit_openai_without_key':
      return `The knowledge graph holds ${OPENAI_TEXT_EMBEDDING_3_SMALL.model} vectors from the old implicit OpenAI default, ` +
        'but the vault has no openai_api_key. Seed openai_api_key in the vault, or configure OpenAI explicitly ' +
        `(${EXPLICIT_OPENAI}), or ${SWITCH_TO_BUNDLED}`;
  }
}

/**
 * The warn line boot logs each time the compatibility rule applies (design §1). It names
 * both ways forward, since the rule goes away in a later release (#2628).
 */
export function describeImplicitOpenAIDeprecation(): string {
  return 'Embeddings use OpenAI through the implicit default (no EMBEDDING_BASE_URL, openai_api_key in the vault, ' +
    `and ${OPENAI_TEXT_EMBEDDING_3_SMALL.model} vectors in the knowledge graph). This default is deprecated and goes away in a later release. ` +
    `To keep OpenAI, configure it explicitly: ${EXPLICIT_OPENAI} (no re-embed needed). ` +
    `Or switch to the bundled model: ${SWITCH_TO_BUNDLED}`;
}

// Internal interface separating the transport/mock concern from the service API.
// Lets us swap OpenAI for a deterministic fake in tests without touching callers.
interface EmbeddingBackend {
  embed(text: string): Promise<number[]>;
}

/**
 * Where an EmbeddingService gets its vectors: an OpenAI-compatible endpoint, or the model
 * bundled in the image, run in-process from a local directory.
 */
export type EmbeddingSource =
  | { kind: 'endpoint'; endpoint: EmbeddingEndpoint }
  | { kind: 'bundled'; modelDir: string };

export class EmbeddingService {
  private constructor(
    private backend: EmbeddingBackend,
    readonly profile: EmbeddingProfile,
  ) {}

  // Production factory for any OpenAI-compatible /embeddings endpoint.
  // Pass bus and modelRegistry to enable embedding.call telemetry.
  // Both are optional so the service still works without them, but in production
  // both should always be provided so costs appear in the audit log.
  static createWithEndpoint(
    endpoint: EmbeddingEndpoint,
    profile: EmbeddingProfile,
    logger: Logger,
    bus?: EventBus,
    modelRegistry?: ModelRegistry,
  ): EmbeddingService {
    return new EmbeddingService(new HttpEmbeddingBackend(endpoint, profile.dimensions, logger, bus, modelRegistry), profile);
  }

  /**
   * Production factory for the bundled model, run in-process from `modelDir`. The profile
   * must carry the weights hash its stamp uses (`hashBundledWeights()`), and this checks
   * it against the file again: vectors stamped with one hash must come from those
   * weights. Loads the session and tokenizer eagerly, so a bad file fails here, at boot.
   *
   * `modelRegistry` is accepted so both factories share a shape for `create()`, and is
   * unused: in-process inference has no price to look up.
   */
  static async createBundled(
    modelDir: string,
    profile: EmbeddingProfile,
    logger: Logger,
    bus?: EventBus,
    _modelRegistry?: ModelRegistry,
  ): Promise<EmbeddingService> {
    if (!profile.weightsSha256) {
      throw new Error(
        `Embedding profile "${profile.model}" has no weightsSha256; the bundled backend needs the hash of the weights it loads (hashBundledWeights())`,
      );
    }
    const actual = await hashBundledWeights(modelDir, logger);
    if (actual !== profile.weightsSha256) {
      throw new Error(
        `Bundled embedding weights in ${modelDir} hash to ${actual}, but the profile's weightsSha256 is ${profile.weightsSha256}. ` +
        'Vectors would be stamped as weights that did not make them',
      );
    }
    const backend = await OnnxEmbeddingBackend.load(modelDir, profile, logger, bus);
    return new EmbeddingService(backend, profile);
  }

  /** Builds the service for either embedding source. */
  static async create(
    source: EmbeddingSource,
    profile: EmbeddingProfile,
    logger: Logger,
    bus?: EventBus,
    modelRegistry?: ModelRegistry,
  ): Promise<EmbeddingService> {
    if (source.kind === 'bundled') {
      return EmbeddingService.createBundled(source.modelDir, profile, logger, bus, modelRegistry);
    }
    return EmbeddingService.createWithEndpoint(source.endpoint, profile, logger, bus, modelRegistry);
  }

  // Test factory — produces deterministic vectors without any network calls.
  static createForTesting(profile: EmbeddingProfile = OPENAI_TEXT_EMBEDDING_3_SMALL): EmbeddingService {
    return new EmbeddingService(new FakeEmbeddingBackend(profile.dimensions), profile);
  }

  async embed(text: string, purpose: EmbeddingPurpose): Promise<number[]> {
    return this.backend.embed(this.profile.prefixes[purpose] + text);
  }

  /**
   * Computes cosine similarity between two vectors.
   * Returns a value in [-1, 1]; 1.0 = identical direction, 0 = orthogonal.
   * Returns 0 if either vector is the zero vector (safe default).
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    // Callers should never pass mismatched vectors — surface misuse immediately
    // rather than silently computing a nonsensical similarity score.
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      // Arrays are guaranteed same length by the check above; ! asserts index is in-bounds
      const ai = a[i]!;
      const bi = b[i]!;
      dotProduct += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    // Guard against division by zero when a vector is all zeros.
    if (denominator === 0) return 0;
    return dotProduct / denominator;
  }
}

/**
 * An embedding endpoint returned a vector whose width is not the profile's (and could not be
 * cut to it: only a wider vector can be). Its own class so the drift check (#2023, design §7)
 * can tell "the endpoint now serves another model under this name" from a network failure or
 * timeout, without matching message text.
 */
export class EmbeddingDimensionError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Unexpected embedding dimensions: ${actual} (the profile expects ${expected})`);
    this.name = 'EmbeddingDimensionError';
  }
}

// -- Production backend: calls an OpenAI-compatible /embeddings endpoint --

class HttpEmbeddingBackend implements EmbeddingBackend {
  private warnedTruncation = false;

  constructor(
    private endpoint: EmbeddingEndpoint,
    private dimensions: number,
    private logger: Logger,
    private bus?: EventBus,
    private modelRegistry?: ModelRegistry,
  ) {}

  async embed(text: string): Promise<number[]> {
    const start = Date.now();
    // Wrap the fetch so network errors surface with context (text length helps
    // diagnose truncation or oversized input issues).
    let response: Response;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.endpoint.apiKey) headers['Authorization'] = `Bearer ${this.endpoint.apiKey}`;
      response = await fetch(`${this.endpoint.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.endpoint.model,
          input: text,
          // Honoured by OpenAI; servers that ignore it return the full width, cut below.
          dimensions: this.dimensions,
        }),
        signal: AbortSignal.timeout(EMBEDDING_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Publish embedding.error so HealthService can track embedding health.
      // Guard: bus is optional (may be null/undefined when used without bus wiring).
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'FETCH_FAILED',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      this.logger.error({ err, textLength: text.length }, 'Embedding endpoint fetch failed');
      throw new Error(`Embedding endpoint fetch error: ${(err as Error).message}`);
    }

    if (!response.ok) {
      // Use .catch() so a body-read failure doesn't swallow the HTTP error
      const body = await response.text().catch(() => '<body unreadable>');
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'API_ERROR',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      this.logger.error({ status: response.status, body }, 'Embedding endpoint request failed');
      throw new Error(`Embedding endpoint API error: ${response.status}`);
    }

    // Wrap JSON parse so a malformed response surfaces as a distinct error
    // rather than an unhandled rejection with no context.
    // usage is marked optional: OpenAI always includes it on success, but
    // malformed HTTP-200 error bodies may omit it; guard with ?? 0 below.
    let json: { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number } };
    try {
      json = await response.json() as { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number } };
    } catch (err) {
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'PARSE_ERROR',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      this.logger.error({ err }, 'Embedding endpoint response JSON parse failed');
      throw new Error(`Embedding endpoint response parse error: ${(err as Error).message}`);
    }

    let embedding = json.data[0]?.embedding;
    // Servers that ignore `dimensions` (llama.cpp, Ollama) return the model's full width.
    // For a Matryoshka-trained model such as Qwen3-Embedding, the leading dimensions are a
    // valid smaller embedding once rescaled to unit length. For any other model they are not.
    if (embedding && embedding.length > this.dimensions) {
      if (!this.warnedTruncation) {
        this.warnedTruncation = true;
        this.logger.warn(
          { model: this.endpoint.model, returnedDimensions: embedding.length, profileDimensions: this.dimensions },
          'Embedding endpoint returned more dimensions than the profile, so Curia truncates each vector to the profile width. Truncation is only valid for Matryoshka-trained models.',
        );
      }
      embedding = truncateAndNormalize(embedding, this.dimensions);
    }
    if (!embedding || embedding.length !== this.dimensions) {
      this.logger.error(
        { expected: this.dimensions, actual: embedding?.length },
        'Embedding endpoint dimension mismatch',
      );
      // Publish embedding.error so HealthService counts malformed responses as failures.
      if (this.bus) {
        this.bus.publish('system', createEmbeddingError({
          model: this.endpoint.model,
          errorType: 'PARSE_ERROR',
        })).catch((publishErr: unknown) => {
          this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
        });
      }
      // A vector of the wrong width means the endpoint serves a different model under the
      // configured name (a wider one was cut above, so only a narrower one lands here). Typed,
      // so the drift check can read it as changed weights rather than an unreachable
      // endpoint. A response with no vector at all is malformed, not another model.
      if (embedding) throw new EmbeddingDimensionError(this.dimensions, embedding.length);
      throw new Error('Unexpected embedding dimensions: the response held no vector');
    }
    // Telemetry — fire-and-forget; must not block or break the caller.
    // void: don't await so embed() latency isn't coupled to bus/audit throughput.
    // ?? 0: usage is optional in the type — a missing field means 0 tokens recorded
    // (cost tracking gap), which is safer than throwing a TypeError.
    const latencyMs = Date.now() - start;
    void this.publishTelemetry(json.usage?.prompt_tokens ?? 0, latencyMs, text);
    return embedding;
  }

  // Publishes an embedding.call telemetry event. Non-fatal — any failure is
  // logged and swallowed so it never breaks the embed() call chain.
  // Only runs when both bus and modelRegistry are wired (production path).
  private async publishTelemetry(
    inputTokens: number,
    latencyMs: number,
    inputText: string,
  ): Promise<void> {
    if (!this.bus || !this.modelRegistry) return;
    try {
      const pricing = this.modelRegistry.getPricing(this.endpoint.model);
      // pricing will always be defined after Task 1 adds the registry entry,
      // but guard defensively so a misconfigured registry doesn't break embed().
      const estimatedCostUsd = pricing
        ? (inputTokens * pricing.inputPerMToken) / 1_000_000
        : 0;

      const event = createEmbeddingCall({
        model: this.endpoint.model,
        inputTokens,
        estimatedCostUsd,
        latencyMs,
        inputTextLength: inputText.length,
      });
      await this.bus.publish('system', event);
    } catch (err) {
      // Telemetry failures must never propagate — log at warn so they're visible
      // in dashboards without impacting the caller.
      this.logger.warn({ err }, 'HttpEmbeddingBackend: failed to publish embedding.call telemetry event — cost tracking gap');
    }
  }
}

export function truncateAndNormalize(vector: number[], dimensions: number): number[] {
  const head = vector.slice(0, dimensions);
  const norm = Math.sqrt(head.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? head : head.map(x => x / norm);
}

// -- Test backend: deterministic fake using a simple LCG seeded by string hash --
// This produces stable, repeatable vectors that differ per input — no network needed.

class FakeEmbeddingBackend implements EmbeddingBackend {
  constructor(private dimensions: number) {}

  async embed(text: string): Promise<number[]> {
    // djb2-style hash: cheap, non-crypto, good enough to differentiate strings
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Force 32-bit integer truncation
    }

    // LCG (linear congruential generator) seeded by the hash to fill the profile's width.
    // Constants from glibc — well-known period, adequate for test use.
    const embedding: number[] = [];
    let seed = Math.abs(hash);
    for (let i = 0; i < this.dimensions; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // Map [0, 0x7fffffff] → [-1, 1] to satisfy the cosine similarity contract
      embedding.push((seed / 0x7fffffff) * 2 - 1);
    }
    return embedding;
  }
}
