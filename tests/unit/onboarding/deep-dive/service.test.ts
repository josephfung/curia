import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { DeepDiveService } from '../../../../src/onboarding/deep-dive/service.js';
import { STALL_MINUTES } from '../../../../src/onboarding/deep-dive/limits.js';
import {
  readDeepDiveState,
  writeDeepDiveState,
  type DeepDiveState,
} from '../../../../src/onboarding/deep-dive/state.js';

const logger = pino({ level: 'silent' });
const NOW = new Date('2026-11-23T12:00:00.000Z');

const base: DeepDiveState = {
  status: 'delivered',
  startedAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:30:00.000Z',
  mailboxIds: ['old'],
  summaryPath: null,
  draftPaths: [],
  reviewTaskId: null,
  backfilled: null,
  spendUsd: 0,
  requests: 0,
  rateLimited: 0,
  error: null,
};

function setup(opts: { mailboxIds?: string[]; run?: (s: DeepDiveState) => Promise<void> } = {}) {
  const data = new Map<string, string>();
  const configStore = {
    get: async (ns: string, k: string) => data.get(`${ns}/${k}`) ?? null,
    set: async (ns: string, k: string, v: string) => {
      data.set(`${ns}/${k}`, v);
      return { stored: true, action: 'created' as const };
    },
  };
  const run = vi.fn(opts.run ?? (async () => undefined));
  const mailboxes = {
    list: async () => (opts.mailboxIds ?? ['personal']).map((id) => ({ id })),
  };
  const svc = new DeepDiveService({
    configStore,
    stateLock: (fn) => fn(),
    mailboxes: mailboxes as never,
    logger,
    now: () => NOW,
    run,
  });
  const read = () => readDeepDiveState(configStore);
  const seed = (s: Partial<DeepDiveState>) => writeDeepDiveState(configStore, { ...base, ...s });
  return { svc, run, read, seed };
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe('DeepDiveService.startOnce', () => {
  it('starts when no state and a mailbox exists', async () => {
    const t = setup({ mailboxIds: ['a', 'b'] });
    expect(await t.svc.startOnce()).toEqual({ started: true });
    const s = await t.read();
    expect(s?.status).toBe('scanning');
    expect(s?.mailboxIds).toEqual(['a', 'b']);
    expect(s?.startedAt).toBe(NOW.toISOString());
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('does not await run', async () => {
    let release!: () => void;
    const t = setup({ run: () => new Promise<void>((r) => { release = r; }) });
    expect(await t.svc.startOnce()).toEqual({ started: true });
    release();
  });

  it.each(['delivered', 'failed'] as const)('is a no-op once a %s state exists', async (status) => {
    const t = setup();
    await t.seed({ status });
    expect(await t.svc.startOnce()).toEqual({ started: false, reason: 'already_ran' });
    expect(t.run).not.toHaveBeenCalled();
  });

  it('starts nothing with no mailbox', async () => {
    const t = setup({ mailboxIds: [] });
    expect(await t.svc.startOnce()).toEqual({ started: false, reason: 'no_mailbox' });
    expect(await t.read()).toBeNull();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('force re-runs a finished run', async () => {
    const t = setup();
    await t.seed({ status: 'delivered' });
    expect(await t.svc.startOnce({ force: true })).toEqual({ started: true });
    const s = await t.read();
    expect(s?.status).toBe('scanning');
    expect(s?.mailboxIds).toEqual(['personal']);
    expect(s?.startedAt).toBe(NOW.toISOString());
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('force refuses while running', async () => {
    const t = setup();
    await t.seed({ status: 'drafting' });
    expect(await t.svc.startOnce({ force: true })).toEqual({ started: false, reason: 'running' });
    expect(t.run).not.toHaveBeenCalled();
  });

  it('marks the run failed with the error when run rejects', async () => {
    const t = setup({ run: async () => { throw new Error('boom'); } });
    await t.svc.startOnce();
    await vi.waitFor(async () => {
      const s = await t.read();
      expect(s?.status).toBe('failed');
      expect(s?.error).toBe('boom');
    });
  });
});

describe('DeepDiveService.resumeIfStalled', () => {
  it('resumes a run older than STALL_MINUTES and touches updatedAt', async () => {
    const t = setup();
    await t.seed({ status: 'scanning', updatedAt: minutesAgo(STALL_MINUTES + 1) });
    expect(await t.svc.resumeIfStalled(NOW)).toBe(true);
    expect(t.run).toHaveBeenCalledTimes(1);
    expect((await t.read())?.updatedAt).toBe(NOW.toISOString());
    // a second tick must not double-resume
    expect(await t.svc.resumeIfStalled(NOW)).toBe(false);
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('ignores a fresh run', async () => {
    const t = setup();
    await t.seed({ status: 'drafting', updatedAt: minutesAgo(STALL_MINUTES - 1) });
    expect(await t.svc.resumeIfStalled(NOW)).toBe(false);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('ignores finished runs and absent state', async () => {
    const t = setup();
    expect(await t.svc.resumeIfStalled(NOW)).toBe(false);
    await t.seed({ status: 'delivered', updatedAt: minutesAgo(1000) });
    expect(await t.svc.resumeIfStalled(NOW)).toBe(false);
    expect(t.run).not.toHaveBeenCalled();
  });
});

describe('DeepDiveService.resumeAtBoot', () => {
  it('resumes any running run regardless of age', async () => {
    const t = setup();
    await t.seed({ status: 'scanning', updatedAt: minutesAgo(1) });
    expect(await t.svc.resumeAtBoot()).toBe(true);
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a finished or absent run', async () => {
    const t = setup();
    expect(await t.svc.resumeAtBoot()).toBe(false);
    await t.seed({ status: 'failed' });
    expect(await t.svc.resumeAtBoot()).toBe(false);
    expect(t.run).not.toHaveBeenCalled();
  });
});
