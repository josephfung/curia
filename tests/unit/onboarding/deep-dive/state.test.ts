import { describe, expect, it, vi } from 'vitest';
import {
  DEEP_DIVE_KEY,
  isRunning,
  readDeepDiveState,
  writeDeepDiveState,
  type DeepDiveState,
} from '../../../../src/onboarding/deep-dive/state.js';

const sample: DeepDiveState = {
  status: 'scanning',
  startedAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:00:00.000Z',
  mailboxIds: ['personal'],
  summaryPath: null,
  draftPaths: [],
  reviewTaskId: null,
  backfilled: null,
  spendUsd: 0,
  requests: 0,
  rateLimited: 0,
  error: null,
};

function fakeStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (ns: string, k: string) => data.get(`${ns}/${k}`) ?? null,
    set: async (ns: string, k: string, v: string) => {
      data.set(`${ns}/${k}`, v);
      return { stored: true, action: 'created' as const };
    },
  };
}

describe('deep-dive state', () => {
  it('round-trips a state', async () => {
    const store = fakeStore();
    await writeDeepDiveState(store, sample);
    expect(store.data.has(`onboarding/${DEEP_DIVE_KEY}`)).toBe(true);
    expect(await readDeepDiveState(store)).toEqual(sample);
  });

  it('returns null when absent', async () => {
    expect(await readDeepDiveState(fakeStore())).toBeNull();
  });

  it('returns null and warns on malformed JSON', async () => {
    const store = fakeStore();
    store.data.set(`onboarding/${DEEP_DIVE_KEY}`, '{not json');
    const warn = vi.fn();
    expect(await readDeepDiveState(store, { warn } as never)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null and warns on a wrong shape', async () => {
    const store = fakeStore();
    store.data.set(`onboarding/${DEEP_DIVE_KEY}`, JSON.stringify({ ...sample, status: 'bogus' }));
    const warn = vi.fn();
    expect(await readDeepDiveState(store, { warn } as never)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('throws when the store rejects the write', async () => {
    const store = { set: async () => ({ stored: false, action: 'rejected' as const }) };
    await expect(writeDeepDiveState(store as never, sample)).rejects.toThrow();
  });

  it('isRunning is true only for scanning and drafting', () => {
    expect(isRunning(null)).toBe(false);
    expect(isRunning({ ...sample, status: 'scanning' })).toBe(true);
    expect(isRunning({ ...sample, status: 'drafting' })).toBe(true);
    expect(isRunning({ ...sample, status: 'delivered' })).toBe(false);
    expect(isRunning({ ...sample, status: 'failed' })).toBe(false);
  });
});
