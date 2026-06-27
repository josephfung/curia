import { describe, it, expect } from 'vitest';
import {
  RESUMABLE_BLOCK_MAX_BYTES,
  RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES,
  documentAccumulatorPointer,
  inlineAccumulatorBytes,
  isDocumentPointer,
  mergeResumableIntoProgress,
  parseResumableBlock,
  prepareResumableBlock,
  readResumableBlock,
  resumableBlockBytes,
  writeResumableBlock,
} from './resumable-progress.js';

const BASE_INPUT = {
  cursor: 'page:3',
  done: 300,
  total: 1300,
  accumulator: ['did:plc:abc', 'did:plc:def'],
  lastSliceUnits: 25,
  next: 'Review page 4 and unfollow obvious accounts',
};

describe('parseResumableBlock', () => {
  it('parses a valid block', () => {
    const block = parseResumableBlock({
      cursor: 'page:3',
      done: 300,
      total: 1300,
      accumulator: ['a', 'b'],
      lastSliceUnits: 25,
      next: 'Continue',
      checkpointedAt: '2026-06-27T00:00:00.000Z',
    });
    expect(block).toEqual({
      cursor: 'page:3',
      done: 300,
      total: 1300,
      accumulator: ['a', 'b'],
      lastSliceUnits: 25,
      next: 'Continue',
      checkpointedAt: '2026-06-27T00:00:00.000Z',
    });
  });

  it('accepts snake_case last_slice_units from persisted JSON', () => {
    const block = parseResumableBlock({
      cursor: 'page:3',
      done: 300,
      total: 1300,
      accumulator: ['a'],
      last_slice_units: 12,
      next: 'Continue',
    });
    expect(block?.lastSliceUnits).toBe(12);
  });

  it('accepts a document pointer accumulator', () => {
    const block = parseResumableBlock({
      ...BASE_INPUT,
      accumulator: { kind: 'document', path: '/projects/audit/findings.md', section: 'flagged' },
    });
    expect(block?.accumulator).toEqual({
      kind: 'document',
      path: '/projects/audit/findings.md',
      section: 'flagged',
    });
  });

  it('accepts an object cursor', () => {
    const block = parseResumableBlock({
      ...BASE_INPUT,
      cursor: { page: 3, offset: 'abc123' },
    });
    expect(block?.cursor).toEqual({ page: 3, offset: 'abc123' });
  });

  it('returns null for invalid blocks', () => {
    expect(parseResumableBlock(null)).toBeNull();
    expect(parseResumableBlock({ ...BASE_INPUT, done: -1 })).toBeNull();
    expect(parseResumableBlock({ ...BASE_INPUT, next: '   ' })).toBeNull();
    expect(parseResumableBlock({ ...BASE_INPUT, accumulator: { kind: 'document', path: '' } })).toBeNull();
  });

  it('rejects non-JSON-serializable cursor values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(parseResumableBlock({ ...BASE_INPUT, cursor: circular })).toBeNull();
    expect(parseResumableBlock({ ...BASE_INPUT, cursor: BigInt(1) })).toBeNull();
  });
});

describe('readResumableBlock / mergeResumableIntoProgress round-trip', () => {
  it('writes and reads back from progress JSON', () => {
    const progress = { notes: [{ at: '2026-06-27T00:00:00.000Z', note: 'started' }] };
    const written = writeResumableBlock(progress, BASE_INPUT);
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    expect(written.progress.notes).toEqual(progress.notes);
    const reread = readResumableBlock(written.progress);
    expect(reread?.cursor).toBe('page:3');
    expect(reread?.done).toBe(300);
    expect(reread?.total).toBe(1300);
    expect(reread?.accumulator).toEqual(['did:plc:abc', 'did:plc:def']);
    expect(reread?.lastSliceUnits).toBe(25);
    expect(reread?.next).toBe(BASE_INPUT.next);
    expect(reread?.checkpointedAt).toBeDefined();
  });

  it('resume can continue from the persisted cursor', () => {
    const progress = { notes: [] };
    const first = writeResumableBlock(progress, BASE_INPUT);
    if (!first.ok) throw new Error('expected write to succeed');

    const resumed = readResumableBlock(first.progress);
    expect(resumed?.cursor).toBe('page:3');

    const second = writeResumableBlock(first.progress, {
      cursor: 'page:4',
      done: 325,
      total: 1300,
      accumulator: [...(resumed?.accumulator as string[]), 'did:plc:ghi'],
      lastSliceUnits: 25,
      next: 'Review page 5',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(readResumableBlock(second.progress)?.cursor).toBe('page:4');
    expect(readResumableBlock(second.progress)?.done).toBe(325);
  });
});

describe('accumulator bounding', () => {
  it('rejects inline accumulators over the cap', () => {
    const big = 'x'.repeat(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES);
    const result = prepareResumableBlock({
      ...BASE_INPUT,
      accumulator: [big],
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'inline_accumulator_overflow') return;
    expect(result.bytes).toBeGreaterThan(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES);
  });

  it('allows a document pointer regardless of inline cap', () => {
    const pointer = documentAccumulatorPointer('/projects/audit/findings.md', 'flagged');
    expect(isDocumentPointer(pointer)).toBe(true);
    expect(inlineAccumulatorBytes(pointer)).toBeLessThan(RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES);

    const result = prepareResumableBlock({
      ...BASE_INPUT,
      accumulator: pointer,
    });
    expect(result.ok).toBe(true);
  });

  it('stress: a long job cannot grow progress.resumable past the block cap', () => {
    let progress: Record<string, unknown> = { notes: [] };
    let cursor = 0;
    let flagged: string[] = [];

    for (let i = 0; i < 500; i++) {
      flagged = [...flagged, `did:plc:${String(i).padStart(6, '0')}`];
      const result = writeResumableBlock(progress, {
        cursor: String(cursor),
        done: i + 1,
        total: 1300,
        accumulator: flagged,
        lastSliceUnits: 25,
        next: 'Keep paging',
      });

      if (!result.ok) {
        expect(result.code).toBe('inline_accumulator_overflow');
        const block = readResumableBlock(progress);
        expect(block).not.toBeNull();
        expect(resumableBlockBytes(block!)).toBeLessThanOrEqual(RESUMABLE_BLOCK_MAX_BYTES);
        return;
      }

      progress = result.progress;
      cursor = i + 1;
      const block = readResumableBlock(progress)!;
      expect(resumableBlockBytes(block)).toBeLessThanOrEqual(RESUMABLE_BLOCK_MAX_BYTES);
      expect(inlineAccumulatorBytes(block.accumulator)).toBeLessThanOrEqual(
        RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES,
      );
    }

    throw new Error('expected accumulator overflow before 500 iterations');
  });
});

describe('mergeResumableIntoProgress', () => {
  it('preserves unrelated progress keys', () => {
    const block = prepareResumableBlock(BASE_INPUT);
    if (!block.ok) throw new Error('expected valid block');
    const merged = mergeResumableIntoProgress({ custom: true, notes: [] }, block.block);
    expect(merged.custom).toBe(true);
    expect(merged.resumable).toEqual(block.block);
  });
});
