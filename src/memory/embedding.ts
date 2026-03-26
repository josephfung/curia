import { EMBEDDING_DIMENSIONS } from './types.js';
import type { Logger } from '../logger.js';

// Internal interface separating the transport/mock concern from the service API.
// Lets us swap OpenAI for a deterministic fake in tests without touching callers.
interface EmbeddingBackend {
  embed(text: string): Promise<number[]>;
}

export class EmbeddingService {
  private backend: EmbeddingBackend;

  private constructor(backend: EmbeddingBackend) {
    this.backend = backend;
  }

  // Production factory — requires a live OpenAI API key.
  static createWithOpenAI(apiKey: string, logger: Logger): EmbeddingService {
    return new EmbeddingService(new OpenAIBackend(apiKey, logger));
  }

  // Test factory — produces deterministic vectors without any network calls.
  static createForTesting(): EmbeddingService {
    return new EmbeddingService(new FakeEmbeddingBackend());
  }

  async embed(text: string): Promise<number[]> {
    return this.backend.embed(text);
  }

  /**
   * Computes cosine similarity between two vectors.
   * Returns a value in [-1, 1]; 1.0 = identical direction, 0 = orthogonal.
   * Returns 0 if either vector is the zero vector (safe default).
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
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

// -- Production backend: calls OpenAI text-embedding-3-small --

class OpenAIBackend implements EmbeddingBackend {
  constructor(private apiKey: string, private logger: Logger) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
        // Requesting the canonical dimension so the DB schema never has to change
        // if we upgrade models later.
        dimensions: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error({ status: response.status, body }, 'OpenAI embedding request failed');
      throw new Error(`OpenAI embedding API error: ${response.status}`);
    }

    const json = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };
    const embedding = json.data[0]?.embedding;
    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Unexpected embedding dimensions: ${embedding?.length}`);
    }
    return embedding;
  }
}

// -- Test backend: deterministic fake using a simple LCG seeded by string hash --
// This produces stable, repeatable vectors that differ per input — no network needed.

class FakeEmbeddingBackend implements EmbeddingBackend {
  async embed(text: string): Promise<number[]> {
    // djb2-style hash: cheap, non-crypto, good enough to differentiate strings
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Force 32-bit integer truncation
    }

    // LCG (linear congruential generator) seeded by the hash to fill EMBEDDING_DIMENSIONS floats.
    // Constants from glibc — well-known period, adequate for test use.
    const embedding: number[] = [];
    let seed = Math.abs(hash);
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // Map [0, 0x7fffffff] → [-1, 1] to satisfy the cosine similarity contract
      embedding.push((seed / 0x7fffffff) * 2 - 1);
    }
    return embedding;
  }
}
