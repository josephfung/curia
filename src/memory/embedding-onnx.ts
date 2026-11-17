/**
 * The bundled embedding backend (design §2): runs all-MiniLM-L6-v2 in-process with
 * onnxruntime-node and @huggingface/tokenizers, from files already on disk.
 *
 * It never fetches. It takes a local directory and nothing else, so a missing file is a
 * boot error naming `pnpm fetch:embedder`, never a download (`scripts/fetch-embedder.ts`
 * is the only code that downloads the weights).
 */
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
// Types only: the runtime module loads lazily, in loadOnnxRuntime() below.
import type { InferenceSession, OnnxValue, Tensor } from 'onnxruntime-node';
import { Tokenizer } from '@huggingface/tokenizers';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import { createEmbeddingCall, createEmbeddingError } from '../bus/events.js';
import { loadEmbedderManifest } from './embedder-manifest.js';
import type { EmbeddingProfile } from './embedding-profiles.js';

/** The weight file the backend loads and the stamp's weights hash covers. */
export const BUNDLED_WEIGHTS_FILE = 'model_quantized.onnx';

/**
 * all-MiniLM-L6-v2's maximum sequence length (its sentence-transformers config), in
 * tokens including [CLS] and [SEP]. Longer input is truncated, keeping the final [SEP].
 */
export const BUNDLED_MAX_TOKENS = 256;

const TOKENIZER_FILE = 'tokenizer.json';
const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json';
const INPUT_NAMES = ['input_ids', 'attention_mask', 'token_type_ids'] as const;
const OUTPUT_NAME = 'last_hidden_state';

type OnnxRuntime = typeof import('onnxruntime-node');
let onnxRuntime: Promise<OnnxRuntime> | undefined;

/**
 * The runtime from a dynamic import's namespace. onnxruntime-node is CommonJS, so this
 * reads `default` (#2410): Node puts module.exports there. tsx's loader, which runs
 * `pnpm reembed:kg` and dev boots, honours the package's `__esModule` flag instead and
 * leaves `default` undefined with the names on the namespace itself, so that shape is
 * accepted too.
 */
export function onnxRuntimeFrom(namespace: OnnxRuntime & { default?: OnnxRuntime }): OnnxRuntime {
  const runtime = namespace.default ?? namespace;
  if (typeof runtime.InferenceSession?.create !== 'function') {
    throw new Error('onnxruntime-node loaded, but exposes no InferenceSession');
  }
  return runtime;
}

/**
 * onnxruntime-node, loaded on first use (ruling R9). Its native addon is about 16 MB
 * resident and may not load on every platform, so an install that embeds through an
 * endpoint must never load it: nothing imports it statically, and only the bundled path
 * calls this. A failed load is not cached, so a later attempt tries again.
 */
function loadOnnxRuntime(): Promise<OnnxRuntime> {
  onnxRuntime ??= import('onnxruntime-node').then(onnxRuntimeFrom).catch((err: unknown) => {
    onnxRuntime = undefined;
    throw new Error(`The ONNX runtime (onnxruntime-node) failed to load: ${(err as Error).message}`, { cause: err });
  });
  return onnxRuntime;
}

/** The part of an ONNX session the backend uses. A stub stands in for it in tests. */
export interface OnnxRunner {
  run(feeds: Record<string, Tensor>): Promise<Record<string, OnnxValue>>;
  /** Frees the native session. InferenceSession has it; a test stub may leave it out. */
  release?(): Promise<void>;
}

/** The part of a tokenizer the backend uses. Padding is off: one text per call. */
export interface TextTokenizer {
  encode(text: string): { ids: number[]; attention_mask: number[] };
}

export type EmbeddingPooling = NonNullable<EmbeddingProfile['pooling']>;

/**
 * A file the bundled model needs is not on disk. Its own class so the boot gate can tell
 * "fetch the weights" (`bundled_weights_missing`) from a file that is there but will not
 * load, without matching message text.
 */
export class BundledModelFileMissingError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(
      `Bundled embedding model file not found: ${file}. Run \`pnpm fetch:embedder\` to fetch the pinned weights, ` +
      `or point EMBEDDING_MODEL_DIR at a directory that holds them`,
      { cause },
    );
    this.name = 'BundledModelFileMissingError';
  }
}

function missingFileError(file: string, err: unknown): Error {
  return new BundledModelFileMissingError(file, err);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * sha256 (hex) of the weight file in `modelDir`: the file actually loaded, not the
 * manifest's value, so the stamp never labels other weights as the shipped ones.
 *
 * A difference from the committed manifest (an EMBEDDING_MODEL_DIR holding another
 * export) is a warning, not an error: the real hash goes into the stamp, and the
 * existing model-mismatch gate handles the rest. Throws only when the file is missing.
 */
export async function hashBundledWeights(modelDir: string, logger: Logger): Promise<string> {
  const file = path.join(modelDir, BUNDLED_WEIGHTS_FILE);
  let actual: string;
  try {
    // One read, not a stream: ~23 MB hashes in tens of milliseconds this way, against
    // most of a second through 64 KB stream chunks, and this runs on every boot.
    actual = createHash('sha256').update(await readFile(file)).digest('hex');
  } catch (err) {
    if (isMissing(err)) throw missingFileError(file, err);
    throw err;
  }

  // Ruling R3: the manifest is the committed one under cwd, whatever modelDir is.
  let expected: string | undefined;
  try {
    const manifest = loadEmbedderManifest();
    expected = manifest.files.find(f => path.basename(f.dest) === BUNDLED_WEIGHTS_FILE)?.sha256;
  } catch (err) {
    // Only a comparison is lost here; the hash itself is still the real one.
    logger.warn({ err, file }, 'Bundled embedder manifest unreadable, so the loaded weights cannot be compared with it');
    return actual;
  }
  if (expected === undefined) {
    logger.warn({ file }, `Bundled embedder manifest lists no ${BUNDLED_WEIGHTS_FILE}, so the loaded weights cannot be compared with it`);
  } else if (expected !== actual) {
    logger.warn(
      { file, manifestSha256: expected, actualSha256: actual },
      'Bundled embedding weights differ from the manifest. Vectors are stamped with the hash of the file actually loaded',
    );
  }
  return actual;
}

export interface OnnxEmbeddingBackendOptions {
  session: OnnxRunner;
  tokenizer: TextTokenizer;
  /** Model name for telemetry and error events (the profile's model). */
  model: string;
  dimensions: number;
  pooling: EmbeddingPooling;
  logger: Logger;
  bus?: EventBus;
}

export class OnnxEmbeddingBackend {
  // Each call chains onto this, so session.run() never runs concurrently on one session.
  // Single-label inference is about a millisecond, so the queue costs nothing (design §2).
  private queue: Promise<unknown> = Promise.resolve();
  // Set by close(), so a second close() waits on the first instead of releasing twice.
  private closing: Promise<void> | undefined;

  constructor(private readonly opts: OnnxEmbeddingBackendOptions) {}

  /**
   * Loads the session and tokenizer from `modelDir`, eagerly, so a missing or corrupt
   * file shows up at boot rather than on the first knowledge-graph write.
   */
  static async load(
    modelDir: string,
    profile: EmbeddingProfile,
    logger: Logger,
    bus?: EventBus,
  ): Promise<OnnxEmbeddingBackend> {
    // Pooling belongs to the weights and comes only from a built-in profile (YAML cannot
    // set it). Without one the backend would be guessing, so it refuses (design §3).
    const pooling = profile.pooling;
    if (!pooling) {
      throw new Error(`Embedding profile "${profile.model}" has no pooling strategy, so the bundled backend cannot run it`);
    }

    const readJson = async (name: string): Promise<object> => {
      const file = path.join(modelDir, name);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if (isMissing(err)) throw missingFileError(file, err);
        throw err;
      }
      try {
        return JSON.parse(text) as object;
      } catch (err) {
        // A plain Error (not BundledModelFileMissingError): the file is there but will not
        // load, which the boot gate reports as bundled_load_failed. Name the file, since
        // JSON.parse's own message does not.
        throw new Error(`${file}: ${(err as Error).message}`, { cause: err });
      }
    };
    const tokenizerJson = await readJson(TOKENIZER_FILE);
    const tokenizerConfig = await readJson(TOKENIZER_CONFIG_FILE);
    let tokenizer: Tokenizer;
    try {
      tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    } catch (err) {
      // Valid JSON the tokenizer cannot use (another format, a truncated vocab). Same
      // classification as above: bundled_load_failed, with the file named.
      const file = path.join(modelDir, TOKENIZER_FILE);
      throw new Error(`${file}: ${(err as Error).message}`, { cause: err });
    }

    const weights = path.join(modelDir, BUNDLED_WEIGHTS_FILE);
    try {
      await access(weights);
    } catch (err) {
      if (isMissing(err)) throw missingFileError(weights, err);
      throw err;
    }
    const ort = await loadOnnxRuntime();
    let session: InferenceSession;
    try {
      session = await ort.InferenceSession.create(weights, {
        executionProviders: ['cpu'],
        // MiniLM needs no more, and the box is shared with Postgres (design §2).
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
      });
    } catch (err) {
      throw new Error(`Bundled embedding model failed to load from ${weights}: ${(err as Error).message}`, { cause: err });
    }

    // Another export in EMBEDDING_MODEL_DIR may name its tensors differently; say so at
    // boot, not as an opaque run() failure on the first write.
    const missingInputs = INPUT_NAMES.filter(n => !session.inputNames.includes(n));
    if (missingInputs.length > 0 || !session.outputNames.includes(OUTPUT_NAME)) {
      // No backend reaches the caller to close it, so release the session here; boot carries
      // on with the knowledge graph off. A failed release is logged; the mismatch is the error.
      try {
        await session.release?.();
      } catch (err) {
        logger.error({ err }, 'Failed to release the bundled embedding model session');
      }
      throw new Error(
        `Bundled embedding model ${weights} has inputs [${session.inputNames.join(', ')}] and outputs ` +
        `[${session.outputNames.join(', ')}]; expected inputs [${INPUT_NAMES.join(', ')}] and output ${OUTPUT_NAME}`,
      );
    }

    logger.info({ modelDir, model: profile.model, dimensions: profile.dimensions }, 'Bundled embedding model loaded');
    return new OnnxEmbeddingBackend({
      session,
      tokenizer,
      model: profile.model,
      dimensions: profile.dimensions,
      pooling,
      logger,
      bus,
    });
  }

  embed(text: string): Promise<number[]> {
    if (this.closing) return Promise.reject(new Error('Bundled embedding backend is closed'));
    const result = this.queue.then(() => this.embedNow(text));
    // The next call waits for this one to settle, not to succeed. The rejection itself
    // still reaches this call's caller through `result`, so nothing is swallowed.
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Releases the native ONNX session. Call it before process.exit(): exiting while a
   * session is alive can abort the process in onnxruntime's native teardown (exit 134)
   * instead of exiting with the intended code. Waits for an in-flight embed() first, so
   * the session is never released under a running inference. Idempotent, and never
   * throws: a failed release is logged, since the caller is on its way out anyway.
   */
  close(): Promise<void> {
    this.closing ??= this.queue.then(async () => {
      try {
        await this.opts.session.release?.();
      } catch (err) {
        this.opts.logger.error({ err }, 'Failed to release the bundled embedding model session');
      }
    });
    return this.closing;
  }

  private async embedNow(text: string): Promise<number[]> {
    // The clock starts after the queue wait, so latencyMs measures the inference itself,
    // as HttpEmbeddingBackend's measures the request rather than time spent before it.
    const start = Date.now();
    let ids: number[] = [];
    let mask: number[] = [];
    let hidden: OnnxValue | undefined;
    let ort: OnnxRuntime;
    try {
      // Already loaded by load(); a backend built from a stub session loads it here.
      ort = await loadOnnxRuntime();
      ({ ids, mask } = truncate(this.opts.tokenizer.encode(text)));
      const n = ids.length;
      const int64 = (values: number[]) => new ort.Tensor('int64', BigInt64Array.from(values, v => BigInt(v)), [1, n]);
      const out = await this.opts.session.run({
        input_ids: int64(ids),
        attention_mask: int64(mask),
        // One segment, so every token type is 0 (BERT's single-sentence convention).
        token_type_ids: int64(new Array<number>(n).fill(0)),
      });
      hidden = out[OUTPUT_NAME];
    } catch (err) {
      this.publishError('INFERENCE_FAILED');
      this.opts.logger.error({ err, textLength: text.length, tokens: ids.length }, 'Bundled embedding inference failed');
      throw new Error(`Bundled embedding inference error: ${(err as Error).message}`, { cause: err });
    }

    const n = ids.length;
    // A float tensor is what pooling reads. Another dtype (an export that outputs float16 or
    // int8 activations) is its own problem, not a shape problem, so it gets its own message.
    if (hidden instanceof ort.Tensor && !(hidden.data instanceof Float32Array)) {
      this.publishError('PARSE_ERROR');
      this.opts.logger.error({ type: hidden.type, dims: hidden.dims }, 'Bundled embedding output has an unexpected dtype');
      throw new Error(`Unexpected embedding output type: ${hidden.type} (expected float32)`);
    }
    const d = hidden instanceof ort.Tensor ? hidden.dims[2] : undefined;
    if (!(hidden instanceof ort.Tensor) || !(hidden.data instanceof Float32Array) || d !== this.opts.dimensions
      || hidden.dims[1] !== n) {
      this.publishError('PARSE_ERROR');
      const dims = hidden instanceof ort.Tensor ? hidden.dims : undefined;
      this.opts.logger.error({ expected: this.opts.dimensions, dims }, 'Bundled embedding output has an unexpected shape');
      throw new Error(`Unexpected embedding dimensions: ${String(dims)} (expected [1, ${n}, ${this.opts.dimensions}])`);
    }

    const embedding = pool(hidden.data, n, d, mask, this.opts.pooling);
    const latencyMs = Date.now() - start;
    // Fire-and-forget, like HttpEmbeddingBackend: telemetry must not delay or break embed().
    void this.publishTelemetry(n, latencyMs, text);
    return embedding;
  }

  private publishError(errorType: string): void {
    if (!this.opts.bus) return;
    this.opts.bus.publish('system', createEmbeddingError({ model: this.opts.model, errorType }))
      .catch((publishErr: unknown) => {
        this.opts.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
      });
  }

  // Unlike HttpEmbeddingBackend, this needs no model registry: in-process inference costs
  // nothing, and HealthService counts embedding.call whatever its cost.
  private async publishTelemetry(inputTokens: number, latencyMs: number, inputText: string): Promise<void> {
    if (!this.opts.bus) return;
    try {
      await this.opts.bus.publish('system', createEmbeddingCall({
        model: this.opts.model,
        inputTokens,
        estimatedCostUsd: 0,
        latencyMs,
        inputTextLength: inputText.length,
      }));
    } catch (err) {
      this.opts.logger.warn({ err }, 'OnnxEmbeddingBackend: failed to publish embedding.call telemetry event');
    }
  }
}

// The tokenizer has no truncation option, so this cuts to BUNDLED_MAX_TOKENS (256, the
// model's sentence-transformers max_seq_length) itself: the first max-1 tokens, then the
// final token ([SEP]), the way sentence-transformers truncates, so a long input still ends
// like a sentence. This is NOT what transformers.js does: its feature-extraction pipeline
// cuts at the tokenizer's model_max_length (512) and drops [SEP]. The two agree on every
// input of 256 tokens or fewer, which covers the short labels the graph embeds; past that
// they differ, and 256 is the length the model was trained at.
function truncate(enc: { ids: number[]; attention_mask: number[] }): { ids: number[]; mask: number[] } {
  if (enc.ids.length <= BUNDLED_MAX_TOKENS) return { ids: enc.ids, mask: enc.attention_mask };
  return {
    ids: [...enc.ids.slice(0, BUNDLED_MAX_TOKENS - 1), enc.ids[enc.ids.length - 1]!],
    mask: enc.attention_mask.slice(0, BUNDLED_MAX_TOKENS),
  };
}

/** Pools the [1, n, d] token vectors into one sentence vector, then L2-normalises it. */
function pool(hidden: Float32Array, n: number, d: number, mask: number[], pooling: EmbeddingPooling): number[] {
  const v: number[] = new Array<number>(d).fill(0);
  if (pooling === 'mean') {
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      count++;
      for (let j = 0; j < d; j++) v[j] = v[j]! + hidden[i * d + j]!;
    }
    // count is 0 only for an all-masked input, which a tokenizer without padding never makes.
    if (count > 0) for (let j = 0; j < d; j++) v[j] = v[j]! / count;
  } else {
    // cls: the first token's vector; last_token: the last one's (no padding, so it is real).
    const row = pooling === 'cls' ? 0 : n - 1;
    for (let j = 0; j < d; j++) v[j] = hidden[row * d + j]!;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}
