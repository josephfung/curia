import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { runDeepDive, SUMMARY_PATH, type RunDeps } from '../../../../src/onboarding/deep-dive/run.js';
import { DeepDiveService } from '../../../../src/onboarding/deep-dive/service.js';
import type { ScanResult } from '../../../../src/onboarding/deep-dive/scan.js';
import {
  readDeepDiveState,
  writeDeepDiveState,
  type DeepDiveState,
} from '../../../../src/onboarding/deep-dive/state.js';
import { ONBOARDING_CREATED_BY } from '../../../../src/onboarding/constants.js';
import type { WorkingDocRow } from '../../../../src/db/working-docs-repo.js';

const logger = pino({ level: 'silent' });
const NOW = new Date('2026-11-23T12:00:00.000Z');

const running: DeepDiveState = {
  status: 'scanning',
  startedAt: '2026-11-23T11:00:00.000Z',
  updatedAt: '2026-11-23T11:00:00.000Z',
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

const emptyScan = (): ScanResult => ({
  messages: [],
  sentBodies: [],
  events: [],
  principalAddresses: ['ceo@acme.example.com'],
  coverage: { messagesRead: 3, eventsRead: 0, requests: 7, rateLimited: 1, truncated: false },
});

function setup(opts: {
  scan?: RunDeps['scan'];
  openTask?: boolean;
  docs?: Record<string, Partial<WorkingDocRow>>;
  now?: () => Date;
  heartbeatMs?: number;
} = {}) {
  const data = new Map<string, string>();
  const written: DeepDiveState[] = [];
  const configStore = {
    get: async (ns: string, k: string) => data.get(`${ns}/${k}`) ?? null,
    set: async (ns: string, k: string, v: string) => {
      data.set(`${ns}/${k}`, v);
      written.push(JSON.parse(v) as DeepDiveState);
      return { stored: true, action: 'created' as const };
    },
  };
  const docs = new Map<string, Partial<WorkingDocRow>>(Object.entries(opts.docs ?? {}));
  const workingDocsRepo = {
    read: vi.fn(async (path: string) => (docs.get(path) ?? null) as WorkingDocRow | null),
    create: vi.fn(async (p: { path: string; body?: string }) => {
      const row = { path: p.path, body: p.body ?? '', version: 1 };
      docs.set(p.path, row);
      return row as WorkingDocRow;
    }),
    update: vi.fn(async (path: string, p: { body?: string; expectedVersion: number }) => {
      const cur = docs.get(path)!;
      const row = { ...cur, body: p.body ?? cur.body, version: (cur.version ?? 1) + 1 };
      docs.set(path, row);
      return { ok: true as const, document: row as WorkingDocRow };
    }),
  };
  const taskRepo = {
    listTasks: vi.fn(async () => (opts.openTask ? [{ id: 'onb-1', parentTaskId: null, createdBy: ONBOARDING_CREATED_BY }] : [])),
    updateTask: vi.fn(async () => ({})),
  };
  const notifyOperator = vi.fn(async () => ({ recorded: true }));
  const scan = vi.fn(opts.scan ?? (async () => emptyScan()));
  const deps: RunDeps = {
    configStore,
    stateLock: (fn) => fn(),
    mailboxes: { list: async () => [] } as never,
    workingDocsRepo,
    taskRepo: taskRepo as never,
    timezone: () => 'America/Toronto',
    logger,
    notifyOperator,
    now: opts.now ?? (() => NOW),
    scan,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  };
  const seed = (s: Partial<DeepDiveState> = {}) => writeDeepDiveState(configStore, { ...running, ...s });
  const read = () => readDeepDiveState(configStore);
  return { deps, seed, read, scan, workingDocsRepo, taskRepo, notifyOperator, docs, written, configStore };
}

describe('runDeepDive', () => {
  it('stores the summary and moves to drafting', async () => {
    const t = setup();
    await t.seed();
    await runDeepDive(t.deps, running);

    expect(t.scan).toHaveBeenCalledTimes(1);
    expect(t.scan.mock.calls[0]![1]).toEqual(['personal']);
    expect(t.workingDocsRepo.create).toHaveBeenCalledTimes(1);
    const created = t.workingDocsRepo.create.mock.calls[0]![0] as unknown as {
      path: string; type: string; frontmatter: Record<string, unknown>; body: string; taskId: string | null;
    };
    expect(created.path).toBe(SUMMARY_PATH);
    expect(SUMMARY_PATH).toBe('/meetings/onboarding/deep-dive/history-summary.md');
    expect(created.type).toBe('deep-dive-summary');
    expect(created.frontmatter).toEqual({ title: 'History summary' });
    expect(created.taskId).toBeNull();
    const fenced = /^```json\n([\s\S]*)\n```\n?$/.exec(created.body);
    expect(fenced).not.toBeNull();
    const summary = JSON.parse(fenced![1]!) as { version: number; coverage: { messagesRead: number } };
    expect(summary.version).toBe(1);
    expect(summary.coverage.messagesRead).toBe(3);

    const s = await t.read();
    expect(s).toMatchObject({ status: 'drafting', summaryPath: SUMMARY_PATH, requests: 7, rateLimited: 1, updatedAt: NOW.toISOString() });
  });

  it('overwrites an earlier summary on a forced re-run', async () => {
    const t = setup({ docs: { [SUMMARY_PATH]: { path: SUMMARY_PATH, body: 'old', version: 4 } } });
    await t.seed();
    await runDeepDive(t.deps, running);
    expect(t.workingDocsRepo.create).not.toHaveBeenCalled();
    expect(t.workingDocsRepo.update).toHaveBeenCalledWith(SUMMARY_PATH, expect.objectContaining({ expectedVersion: 4 }));
    expect((await t.read())?.status).toBe('drafting');
  });

  it('resumes drafting without rescanning', async () => {
    const t = setup({ docs: { [SUMMARY_PATH]: { path: SUMMARY_PATH, body: '```json\n{}\n```', version: 1 } } });
    const drafting = { ...running, status: 'drafting' as const, summaryPath: SUMMARY_PATH };
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(t.scan).not.toHaveBeenCalled();
    expect(t.workingDocsRepo.create).not.toHaveBeenCalled();
    expect(t.workingDocsRepo.update).not.toHaveBeenCalled();
    expect((await t.read())).toMatchObject({ status: 'drafting', summaryPath: SUMMARY_PATH });
  });

  it('rescans when the stored summary has gone', async () => {
    const t = setup();
    const drafting = { ...running, status: 'drafting' as const, summaryPath: SUMMARY_PATH };
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(t.scan).toHaveBeenCalledTimes(1);
    expect(t.workingDocsRepo.create).toHaveBeenCalledTimes(1);
  });

  it('marks failed, notifies deep_dive_failed and notes the open onboarding task on error', async () => {
    const t = setup({ openTask: true, scan: async () => { throw new Error('grant revoked'); } });
    await t.seed();
    await runDeepDive(t.deps, running);
    expect(await t.read()).toMatchObject({ status: 'failed', error: 'grant revoked' });
    expect(t.notifyOperator).toHaveBeenCalledWith('onb-1', 'deep_dive_failed');
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('onb-1', { progressNote: expect.stringContaining('Deep dive failed') });
  });

  it('marks failed but sends no notice when no onboarding task is open', async () => {
    const t = setup({ openTask: false, scan: async () => { throw new Error('grant revoked'); } });
    await t.seed();
    await runDeepDive(t.deps, running);
    expect((await t.read())?.status).toBe('failed');
    expect(t.notifyOperator).not.toHaveBeenCalled();
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
  });

  it('a failure of a superseded run leaves the newer run alone', async () => {
    const t = setup({ openTask: true });
    await t.seed();
    const newer: DeepDiveState = { ...running, startedAt: '2026-11-23T11:30:00.000Z', updatedAt: '2026-11-23T11:30:00.000Z' };
    // A newer forced run takes over mid-scan, then this run's scan fails late.
    t.scan.mockImplementation(async () => {
      await writeDeepDiveState(t.configStore, newer);
      throw new Error('late');
    });
    await runDeepDive(t.deps, running);
    expect(t.scan).toHaveBeenCalledTimes(1);
    expect(await t.read()).toEqual(newer);
    expect(t.notifyOperator).not.toHaveBeenCalled();
    expect(t.taskRepo.updateTask).not.toHaveBeenCalled();
  });

  it('stops without writing when the run was superseded during the scan', async () => {
    const t = setup();
    await t.seed();
    t.scan.mockImplementation(async () => {
      await writeDeepDiveState(t.configStore, { ...running, status: 'delivered', startedAt: '2026-11-23T11:30:00.000Z' });
      return emptyScan();
    });
    await runDeepDive(t.deps, running);
    expect(t.workingDocsRepo.create).not.toHaveBeenCalled();
    expect((await t.read())?.status).toBe('delivered');
  });

  it('touches updatedAt while the scan runs, so a live run never looks stalled', async () => {
    let clock = NOW;
    const t = setup({ now: () => clock, heartbeatMs: 5 });
    await t.seed();
    t.scan.mockImplementation(async () => {
      clock = new Date(NOW.getTime() + 10 * 60_000);
      await vi.waitFor(() => {
        expect(t.written.some((s) => s.status === 'scanning' && s.updatedAt === clock.toISOString())).toBe(true);
      });
      return emptyScan();
    });
    await runDeepDive(t.deps, running);
    expect((await t.read())?.status).toBe('drafting');
  });
});

describe('DeepDiveService with the real pipeline', () => {
  it('resumeAtBoot resumes a fresh scanning run', async () => {
    const t = setup();
    await t.seed({ updatedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const svc = new DeepDiveService({ ...t.deps });
    expect(await svc.resumeAtBoot()).toBe(true);
    await vi.waitFor(async () => {
      expect((await t.read())?.status).toBe('drafting');
    });
    expect(t.scan).toHaveBeenCalledTimes(1);
  });
});
