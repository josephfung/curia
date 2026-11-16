// Unit tests for the endpoint weight-drift check (#2023, design §7 "Weight drift"): the
// stored vectors are the baseline, so the check re-embeds a few stored labels and compares.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DRIFT_SAME_MIN,
  DRIFT_SHIFT_FLOOR,
  DRIFT_TIMEOUT_MS,
  checkEmbeddingDrift,
  sampleStoredLabels,
} from '../../../src/memory/embedding-drift.js';
import { EmbeddingDimensionError, EmbeddingService } from '../../../src/memory/embedding.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL, embeddingStamp, type EmbeddingProfile } from '../../../src/memory/embedding-profiles.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { DbPool } from '../../../src/db/connection.js';

const DIMS = 8;
const PROFILE: EmbeddingProfile = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, dimensions: DIMS };
const logger = createSilentLogger();

/** A unit vector along axis `i`. */
function axis(i: number): number[] {
  return Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
}

/** A unit vector whose cosine with axis(i) is exactly `cos` (tilted toward the next axis). */
function tilted(i: number, cos: number): number[] {
  const v = axis(i);
  v[(i + 1) % DIMS] = Math.sqrt(1 - cos * cos);
  v[i] = cos;
  return v;
}

const LABELS = ['Marigold Ventures', 'role: head of procurement', 'Project Bluefin', 'Harbourlight Studio', 'status: on hold'];

/** A stable, invented row id for sample row i. */
function rowId(i: number): string {
  return `00000000-0000-4000-8000-00000000000${i}`;
}

/** Stored rows as pgvector returns them: the vector as text. */
function poolWithRows(rows: Array<{ id?: string; label: string; embedding: number[] }>) {
  const query = vi.fn().mockResolvedValue({
    rows: rows.map((r, i) => ({ id: r.id ?? rowId(i), label: r.label, embedding: `[${r.embedding.join(',')}]` })),
  });
  return { pool: { query } as unknown as DbPool, query };
}

const storedRows = () => LABELS.map((label, i) => ({ label, embedding: axis(i) }));

/** A fake endpoint service: for label i, returns `vectorFor(i)`. */
function fakeService(vectorFor: (i: number, label: string) => Promise<number[]> | number[]) {
  const embed = vi.fn(async (label: string, _purpose: string) => vectorFor(LABELS.indexOf(label), label));
  return { service: { profile: PROFILE, embed } as unknown as EmbeddingService, embed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('drift thresholds', () => {
  it('orders the floor below the same-weights minimum', () => {
    expect(DRIFT_SHIFT_FLOOR).toBeGreaterThan(0);
    expect(DRIFT_SHIFT_FLOOR).toBeLessThan(DRIFT_SAME_MIN);
    expect(DRIFT_SAME_MIN).toBe(0.995);
    expect(DRIFT_TIMEOUT_MS).toBe(5000);
  });
});

describe('sampleStoredLabels', () => {
  it('reads rows carrying the stamp, deterministically by id, with bound parameters, and parses the vectors', async () => {
    const { pool, query } = poolWithRows([{ label: 'Project Bluefin', embedding: [0.5, -0.25, 1] }]);

    const rows = await sampleStoredLabels(pool, 'some-model', 3);

    expect(rows).toEqual([{ id: rowId(0), label: 'Project Bluefin', embedding: [0.5, -0.25, 1] }]);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/SELECT id, label,/);
    expect(sql).toMatch(/WHERE embedding_model = \$1 AND embedding IS NOT NULL ORDER BY id LIMIT \$2/);
    expect(params).toEqual(['some-model', 3]);
  });
});

describe('checkEmbeddingDrift', () => {
  it('reports same when the endpoint gives back the stored vectors, embedding with the document purpose', async () => {
    const { pool, query } = poolWithRows(storedRows());
    const { service, embed } = fakeService((i) => axis(i));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('same');
    expect(query.mock.calls[0]![1]).toEqual([embeddingStamp(PROFILE), 5]);
    expect(embed.mock.calls.map(c => c[1])).toEqual(['document', 'document', 'document', 'document', 'document']);
  });

  it('reports shifted when the lowest cosine falls between the floor and the same-weights minimum', async () => {
    const between = (DRIFT_SHIFT_FLOOR + DRIFT_SAME_MIN) / 2;
    const { pool } = poolWithRows(storedRows());
    // Only one label moved: the minimum decides.
    const { service } = fakeService((i) => (i === 1 ? tilted(i, between) : axis(i)));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('shifted');
  });

  // The same-weights edge, at explicit cosines: hosted and GPU endpoints are not bit-for-bit
  // repeatable, so a cosine just under 1 must still read as same (R13).
  it.each([
    [0.9999, 'same'],
    [0.997, 'same'],
    [0.9951, 'same'],
    [0.995, 'same'],
    [0.9949, 'shifted'],
    // The lowest measured re-quantisation (EmbeddingGemma 2 q4 vs q8) still reads as shifted.
    [0.9809, 'shifted'],
  ])('reports cosine %s as %s', async (cos, expected) => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => (i === 0 ? tilted(i, cos) : axis(i)));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe(expected);
  });

  it('reports shifted at the floor itself', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => tilted(i, DRIFT_SHIFT_FLOOR));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('shifted');
  });

  it('reports changed when the vectors are unrelated to the stored ones', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => axis((i + 4) % DIMS));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('changed');
  });

  it('reports changed just under the floor', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => tilted(i, DRIFT_SHIFT_FLOOR - 0.001));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('changed');
  });

  // R21: the median decides `changed`, so one row whose vector no longer matches its label
  // (a renamed merge survivor, older data) cannot switch the knowledge graph off.
  it('reports shifted, not changed, when one of five rows is an outlier, and warns with its id and cosine only', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => (i === 3 ? tilted(i, 0.1) : tilted(i, 0.9995)));
    const testLogger = createSilentLogger();
    const warn = vi.spyOn(testLogger, 'warn');

    expect(await checkEmbeddingDrift(pool, service, testLogger)).toBe('shifted');

    expect(warn).toHaveBeenCalledOnce();
    const [fields] = warn.mock.calls[0]! as unknown as [Record<string, unknown>, string];
    const outliers = fields['outliers'] as Array<{ id: string; cosine: number }>;
    expect(outliers).toHaveLength(1);
    expect(outliers[0]!.id).toBe(rowId(3));
    expect(outliers[0]!.cosine).toBeCloseTo(0.1, 6);
    // Labels are user data: none reaches the log.
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(LABELS[3]!);
  });

  it('reports changed when every row scores like a different model', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => tilted(i, 0.06));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('changed');
  });

  it('reports changed when three of five rows are low and two are high (the median is low)', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => (i < 3 ? tilted(i, 0.06) : tilted(i, 0.9995)));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('changed');
  });

  it('does not warn about outliers when no row is below the floor', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => (i === 1 ? tilted(i, 0.98) : axis(i)));
    const testLogger = createSilentLogger();
    const warn = vi.spyOn(testLogger, 'warn');

    expect(await checkEmbeddingDrift(pool, service, testLogger)).toBe('shifted');
    expect(warn).not.toHaveBeenCalled();
  });

  it('takes the median of what is there for a graph smaller than the sample', async () => {
    // Three rows: one outlier, two high -> median high -> shifted.
    const three = storedRows().slice(0, 3);
    const { pool } = poolWithRows(three);
    const { service } = fakeService((i) => (i === 0 ? tilted(i, 0.1) : axis(i)));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('shifted');

    // Two rows: one low, one high -> the median is their mean (~0.55) -> changed.
    const { pool: pool2 } = poolWithRows(storedRows().slice(0, 2));
    const { service: service2 } = fakeService((i) => (i === 0 ? tilted(i, 0.1) : axis(i)));

    expect(await checkEmbeddingDrift(pool2, service2, logger)).toBe('changed');
  });

  it('reports same for an empty graph (nothing to compare, nothing to protect)', async () => {
    const { pool } = poolWithRows([]);
    const { service, embed } = fakeService((i) => axis(i));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('same');
    expect(embed).not.toHaveBeenCalled();
  });

  it('reports unchecked when the service throws on one label', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService((i) => {
      if (i === 2) throw new Error('connect ECONNREFUSED');
      return axis(i);
    });

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('unchecked');
  });

  it('reports changed when the endpoint answers with vectors of another width (another model)', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService(() => {
      throw new EmbeddingDimensionError(DIMS, DIMS / 2);
    });

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('changed');
  });

  it('still reports unchecked for a timeout-shaped fetch failure', async () => {
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService(() => {
      throw new Error('Embedding endpoint fetch error: The operation was aborted due to timeout');
    });

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('unchecked');
  });

  it('reports unchecked when the sample cannot be read', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db gone')) } as unknown as DbPool;
    const { service } = fakeService((i) => axis(i));

    expect(await checkEmbeddingDrift(pool, service, logger)).toBe('unchecked');
  });

  it('reports unchecked, without waiting longer than the timeout, when the service never answers', async () => {
    vi.useFakeTimers();
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService(() => new Promise<number[]>(() => {}));

    let outcome: string | undefined;
    const pending = checkEmbeddingDrift(pool, service, logger, 1000).then((o) => { outcome = o; });

    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(outcome).toBe('unchecked');
  });

  it('defaults the timeout to DRIFT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const { pool } = poolWithRows(storedRows());
    const { service } = fakeService(() => new Promise<number[]>(() => {}));

    let outcome: string | undefined;
    const pending = checkEmbeddingDrift(pool, service, logger).then((o) => { outcome = o; });

    await vi.advanceTimersByTimeAsync(DRIFT_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(outcome).toBe('unchecked');
  });

  it('agrees with EmbeddingService.cosineSimilarity on the boundary', () => {
    // Guards the helper the tests use to aim at a cosine.
    expect(EmbeddingService.cosineSimilarity(axis(0), tilted(0, 0.95))).toBeCloseTo(0.95, 12);
  });
});
