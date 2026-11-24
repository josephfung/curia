import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  DRAFT_PATHS,
  runDeepDive,
  SUMMARY_PATH,
  type RunDeps,
} from '../../../../src/onboarding/deep-dive/run.js';
import { DeepDiveService } from '../../../../src/onboarding/deep-dive/service.js';
import type { ScanResult } from '../../../../src/onboarding/deep-dive/scan.js';
import { DraftError, type DraftDeps, type DraftInputs, type DraftKind } from '../../../../src/onboarding/deep-dive/draft.js';
import type { Correspondent, HistorySummary } from '../../../../src/onboarding/deep-dive/history-summary.js';
import {
  readDeepDiveState,
  writeDeepDiveState,
  type DeepDiveState,
} from '../../../../src/onboarding/deep-dive/state.js';
import { ONBOARDING_CREATED_BY } from '../../../../src/onboarding/constants.js';
import type { WorkingDocRow } from '../../../../src/db/working-docs-repo.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';

const logger = pino({ level: 'silent' });
const NOW = new Date('2026-11-23T12:00:00.000Z');
const DIR = '/meetings/onboarding/deep-dive/';
const ALL_DRAFTS = [
  '/meetings/onboarding/deep-dive/working-rules.md',
  '/meetings/onboarding/deep-dive/time-and-priorities.md',
  '/meetings/onboarding/deep-dive/writing-voice.md',
];

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
const drafting: DeepDiveState = { ...running, status: 'drafting', summaryPath: SUMMARY_PATH };

const emptyScan = (): ScanResult => ({
  messages: [],
  sentBodies: [],
  events: [],
  principalAddresses: ['ceo@acme.example.com'],
  coverage: { messagesRead: 3, eventsRead: 0, requests: 7, rateLimited: 1, errors: 0, truncated: false },
});

function person(email: string): Correspondent {
  return {
    email, name: null, domain: email.split('@')[1]!, kind: 'person', received: 3, sent: 2, twoWay: true,
    medianReplyMinutes: null, evidence: { messageIds: ['m1'] },
  };
}

function summary(over: Partial<HistorySummary> = {}): HistorySummary {
  return {
    version: 1,
    generatedAt: '2026-11-23T00:00:00.000Z',
    window: { from: '2026-08-25T00:00:00.000Z', to: '2026-11-23T00:00:00.000Z' },
    coverage: { messagesRead: 40, eventsRead: 10, requests: 5, rateLimited: 0, errors: 0, truncated: false },
    principalAddresses: ['boss@example.com'],
    correspondents: [person('dana@example.org'), person('lee@example.net')],
    unopened: [],
    handedOff: [],
    recurringMeetings: [],
    meetingShape: { medianMinutes: 30, bufferMinutesMedian: 10, keptClearBlocks: [], declinedOrMoved: 0, evidence: {} },
    timeSpent: [],
    voiceSample: [],
    ...over,
  };
}

const summaryDoc = (s: unknown = summary()): Partial<WorkingDocRow> => ({
  path: SUMMARY_PATH,
  body: '```json\n' + JSON.stringify(s, null, 2) + '\n```\n',
  version: 1,
});

const NOTE_TAIL = 'Copy each to a Google Doc and book the review (onboarding skill, "Deep-dive review").';

function setup(opts: {
  scan?: RunDeps['scan'];
  openTask?: boolean;
  docs?: Record<string, Partial<WorkingDocRow>>;
  tasks?: Partial<TaskRow>[];
  now?: () => Date;
  heartbeatMs?: number;
  draft?: RunDeps['draft'];
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
  const tasks = new Map<string, Partial<TaskRow>>();
  if (opts.openTask) tasks.set('onb-1', { id: 'onb-1', parentTaskId: null, createdBy: ONBOARDING_CREATED_BY, status: 'waiting', tags: ['onboarding'] });
  for (const t of opts.tasks ?? []) tasks.set(t.id!, t);
  let nextTask = 1;
  const taskRepo = {
    listTasks: vi.fn(async () => [...tasks.values()].filter((t) => t.tags?.includes('onboarding') && t.status !== 'done')),
    updateTask: vi.fn(async () => ({})),
    getTask: vi.fn(async (id: string) => (tasks.get(id) ?? null) as TaskRow | null),
    createTask: vi.fn(async (p: { title: string; tags?: string[]; status?: string }) => {
      const row = { id: `review-${nextTask++}`, parentTaskId: null, title: p.title, tags: p.tags ?? [], status: p.status ?? 'open' };
      tasks.set(row.id, row as Partial<TaskRow>);
      return row as TaskRow;
    }),
    setActiveSkillsBlock: vi.fn(async () => ({ task: {}, block: { skills: [] } })),
  };
  let nextContact = 1;
  const contactService = {
    resolveByChannelIdentity: vi.fn(async () => null),
    createContactWithKgOutcome: vi.fn(async () => ({ contact: { id: `c-${nextContact++}` }, kgNodeCreated: true })),
    linkIdentity: vi.fn(async () => undefined),
    deleteContact: vi.fn(async () => undefined),
  };
  const onboardingService = {
    openSession: vi.fn(async () => ({ ok: true as const, session: { id: 'review' }, createdSubtasks: 3 })),
  };
  const scheduler = {
    enqueueTaskWake: vi.fn(async () => ({})),
    runTaskWakeEarly: vi.fn(async () => 'none' as const),
  };
  const executiveProfile = { get: vi.fn(() => ({ writingVoice: null })), update: vi.fn() };
  const officeIdentity = { get: vi.fn(() => ({ behavioralPreferences: ['No meetings before 10'] })), update: vi.fn() };
  const readWorkingHours = vi.fn(async () => 'Weekdays 9-5');
  const notifyOperator = vi.fn(async () => ({ recorded: true }));
  const scan = vi.fn(opts.scan ?? (async () => emptyScan()));
  const draft = vi.fn(opts.draft ?? (async (_d: DraftDeps, _i: DraftInputs, kinds?: readonly DraftKind[]) => ({
    drafts: Object.fromEntries((kinds ?? []).map((k) => [k, `# ${k}`])) as Partial<Record<DraftKind, string>>,
    spendUsd: 0.5 * (kinds?.length ?? 0),
  })));
  const deps: RunDeps = {
    configStore,
    stateLock: (fn) => fn(),
    mailboxes: { list: async () => [] } as never,
    workingDocsRepo,
    taskRepo: taskRepo as never,
    contactService: contactService as never,
    onboardingService: onboardingService as never,
    scheduler: scheduler as never,
    providerRouter: { id: 'fake-router' } as never,
    modelRouter: { id: 'fake-model-router' } as never,
    bus: { id: 'fake-bus' } as never,
    estimateCost: (() => 0) as never,
    modelRegistry: { id: 'fake-registry' } as never,
    executiveProfile: executiveProfile as never,
    officeIdentity: officeIdentity as never,
    readWorkingHours,
    timezone: () => 'America/Toronto',
    logger,
    notifyOperator,
    now: opts.now ?? (() => NOW),
    scan,
    draft,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  };
  const seed = (s: Partial<DeepDiveState> = {}) => writeDeepDiveState(configStore, { ...running, ...s });
  const read = () => readDeepDiveState(configStore);
  return {
    deps, seed, read, scan, draft, workingDocsRepo, taskRepo, contactService, onboardingService, scheduler,
    executiveProfile, officeIdentity, notifyOperator, docs, written, configStore,
  };
}

describe('runDeepDive', () => {
  it('stores the summary, then runs to delivered', async () => {
    const t = setup();
    await t.seed();
    await runDeepDive(t.deps, running);

    expect(t.scan).toHaveBeenCalledTimes(1);
    expect(t.scan.mock.calls[0]![1]).toEqual(['personal']);
    const created = t.workingDocsRepo.create.mock.calls.find((c) => c[0].path === SUMMARY_PATH)![0] as unknown as {
      path: string; type: string; frontmatter: Record<string, unknown>; body: string; taskId: string | null;
    };
    expect(SUMMARY_PATH).toBe('/meetings/onboarding/deep-dive/history-summary.md');
    expect(created.type).toBe('deep-dive-summary');
    expect(created.frontmatter).toEqual({ title: 'History summary', editable_by: 'console' });
    expect(created.taskId).toBeNull();
    const fenced = /^```json\n([\s\S]*)\n```\n?$/.exec(created.body);
    expect(fenced).not.toBeNull();
    const stored = JSON.parse(fenced![1]!) as { version: number; coverage: { messagesRead: number } };
    expect(stored.version).toBe(1);
    expect(stored.coverage.messagesRead).toBe(3);

    // The scan's numbers are recorded on the way through drafting.
    expect(t.written.some((s) => s.status === 'drafting' && s.requests === 7 && s.rateLimited === 1)).toBe(true);
    expect(await t.read()).toMatchObject({
      status: 'delivered', summaryPath: SUMMARY_PATH, requests: 7, rateLimited: 1, updatedAt: NOW.toISOString(),
    });
  });

  it('overwrites an earlier summary on a forced re-run', async () => {
    const t = setup({ docs: { [SUMMARY_PATH]: { path: SUMMARY_PATH, body: 'old', version: 4 } } });
    await t.seed();
    await runDeepDive(t.deps, running);
    expect(t.workingDocsRepo.create).not.toHaveBeenCalledWith(expect.objectContaining({ path: SUMMARY_PATH }));
    expect(t.workingDocsRepo.update).toHaveBeenCalledWith(SUMMARY_PATH, expect.objectContaining({
      expectedVersion: 4,
      frontmatter: { title: 'History summary', editable_by: 'console' },
    }));
    expect((await t.read())?.status).toBe('delivered');
  });

  it('resumes drafting without rescanning', async () => {
    const t = setup({ docs: { [SUMMARY_PATH]: summaryDoc() } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(t.scan).not.toHaveBeenCalled();
    expect(t.workingDocsRepo.create).not.toHaveBeenCalledWith(expect.objectContaining({ path: SUMMARY_PATH }));
    expect(t.workingDocsRepo.update).not.toHaveBeenCalledWith(SUMMARY_PATH, expect.anything());
    expect(await t.read()).toMatchObject({ status: 'delivered', summaryPath: SUMMARY_PATH, backfilled: 2 });
  });

  it('rescans when the stored summary has gone', async () => {
    const t = setup();
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(t.scan).toHaveBeenCalledTimes(1);
    expect(t.workingDocsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ path: SUMMARY_PATH }));
  });

  it('fails the run on a malformed stored summary, without backfilling or drafting', async () => {
    const t = setup({ openTask: true, docs: { [SUMMARY_PATH]: summaryDoc({ version: 2, correspondents: 'x' }) } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(await t.read()).toMatchObject({ status: 'failed', error: expect.stringMatching(/history summary is malformed/) });
    expect(t.contactService.resolveByChannelIdentity).not.toHaveBeenCalled();
    expect(t.draft).not.toHaveBeenCalled();
    expect(t.notifyOperator).toHaveBeenCalledWith('onb-1', 'deep_dive_failed');
  });

  it('reads a stored summary saved with CRLF line endings', async () => {
    const crlf = summaryDoc().body!.replace(/\n/g, '\r\n');
    const t = setup({ openTask: true, docs: { [SUMMARY_PATH]: { path: SUMMARY_PATH, body: crlf, version: 1 } } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(await t.read()).toMatchObject({ status: 'delivered', backfilled: 2 });
  });

  it('fails the run when the stored summary body is not fenced JSON', async () => {
    const t = setup({ docs: { [SUMMARY_PATH]: { path: SUMMARY_PATH, body: 'not json', version: 1 } } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(await t.read()).toMatchObject({ status: 'failed', error: expect.stringMatching(/history summary is malformed/) });
    expect(t.draft).not.toHaveBeenCalled();
  });

  it('hands off to the open onboarding task', async () => {
    const t = setup({ openTask: true, docs: { [SUMMARY_PATH]: summaryDoc() } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);

    expect(t.taskRepo.createTask).not.toHaveBeenCalled();
    expect(t.onboardingService.openSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'onb-1' }), 'review');
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('onb-1', {
      progressNote:
        `Deep-dive drafts ready: ${ALL_DRAFTS.join(', ')}. Contacts added: 2. ` +
        `Coverage: 2026-08-25–2026-11-23. ${NOTE_TAIL}`,
    });
    expect(t.scheduler.enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'onb-1', agentId: 'coordinator' }));
    expect(await t.read()).toMatchObject({
      status: 'delivered', reviewTaskId: 'onb-1', backfilled: 2, draftPaths: ALL_DRAFTS, spendUsd: 1.5, error: null,
    });

    for (const [i, path] of ALL_DRAFTS.entries()) {
      expect(t.workingDocsRepo.create).toHaveBeenCalledWith({
        path,
        type: 'deep-dive-draft',
        frontmatter: { title: ['Working rules (draft)', 'Time and priorities (draft)', 'Writing voice (draft)'][i], editable_by: 'console' },
        body: expect.any(String),
        taskId: null,
      });
    }
    expect(DRAFT_PATHS).toEqual({
      'working-rules': ALL_DRAFTS[0],
      'time-and-priorities': ALL_DRAFTS[1],
      'writing-voice': ALL_DRAFTS[2],
    });
  });

  it('creates one standalone deep-dive task when onboarding is closed', async () => {
    const t = setup({ docs: { [SUMMARY_PATH]: summaryDoc(summary({ coverage: { ...summary().coverage, truncated: true } })) } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);

    expect(t.taskRepo.createTask).toHaveBeenCalledTimes(1);
    expect(t.taskRepo.createTask).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'coordinator',
      title: 'Review your deep-dive drafts',
      tags: ['deep-dive'],
      createdBy: ONBOARDING_CREATED_BY,
      source: 'scheduler',
      owner: 'curia',
      status: 'open',
    }));
    expect(t.taskRepo.setActiveSkillsBlock).toHaveBeenCalledWith('review-1', {
      skills: [{ name: 'onboarding', activatedAt: expect.any(String) }],
    });
    expect(t.onboardingService.openSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'review-1' }), 'review');
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('review-1', {
      progressNote: expect.stringContaining('Coverage: 2026-08-25–2026-11-23, truncated. Copy each'),
    });
    expect(t.scheduler.enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'review-1' }));
    expect(await t.read()).toMatchObject({ status: 'delivered', reviewTaskId: 'review-1' });
  });

  it('does not create a second review task on resume', async () => {
    const draftDocs = Object.fromEntries(ALL_DRAFTS.map((p) => [p, { path: p, body: '# d', version: 1 }]));
    const t = setup({
      docs: { [SUMMARY_PATH]: summaryDoc(), ...draftDocs },
      tasks: [{ id: 'review-7', parentTaskId: null, status: 'open', tags: ['deep-dive'] }],
    });
    const midHandoff = { ...drafting, backfilled: 2, draftPaths: ALL_DRAFTS, reviewTaskId: 'review-7', spendUsd: 1.5 };
    await t.seed(midHandoff);
    await runDeepDive(t.deps, midHandoff);

    expect(t.taskRepo.createTask).not.toHaveBeenCalled();
    expect(t.contactService.resolveByChannelIdentity).not.toHaveBeenCalled();
    expect(t.draft).not.toHaveBeenCalled();
    expect(t.onboardingService.openSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'review-7' }), 'review');
    expect(await t.read()).toMatchObject({ status: 'delivered', reviewTaskId: 'review-7', spendUsd: 1.5 });
  });

  it('records the review task before opening its session, so a crash there does not make a second', async () => {
    const t = setup({ docs: { [SUMMARY_PATH]: summaryDoc() } });
    await t.seed(drafting);
    t.onboardingService.openSession.mockRejectedValueOnce(new Error('db blip'));
    await runDeepDive(t.deps, drafting);
    // The failure is recorded on a state that already names the task it created.
    expect(await t.read()).toMatchObject({ status: 'failed', reviewTaskId: 'review-1' });
    // With no onboarding open, the failure is noted on that review task, and the coordinator woken there.
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('review-1', { progressNote: expect.stringContaining(ALL_DRAFTS[2]!) });
    expect(t.scheduler.enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'review-1' }));
    expect(t.notifyOperator).toHaveBeenCalledWith('review-1', 'deep_dive_failed');
  });

  it('drafts only the drafts a resumed run has not written yet', async () => {
    const first = ALL_DRAFTS[0]!;
    const t = setup({ openTask: true, docs: { [SUMMARY_PATH]: summaryDoc(), [first]: { path: first, body: '# d', version: 1 } } });
    const resumed = { ...drafting, backfilled: 2, draftPaths: [first], spendUsd: 0.5 };
    await t.seed(resumed);
    await runDeepDive(t.deps, resumed);
    expect(t.draft).toHaveBeenCalledTimes(2);
    expect(t.draft.mock.calls.map((c) => c[2])).toEqual([['time-and-priorities'], ['writing-voice']]);
    expect(await t.read()).toMatchObject({ status: 'delivered', draftPaths: ALL_DRAFTS, spendUsd: 1.5 });
  });

  it('redrafts over an earlier run\'s drafts on a forced re-run', async () => {
    const draftDocs = Object.fromEntries(ALL_DRAFTS.map((p) => [p, { path: p, body: 'old', version: 3 }]));
    const t = setup({ openTask: true, docs: { [SUMMARY_PATH]: summaryDoc(), ...draftDocs } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(t.draft).toHaveBeenCalledTimes(3);
    for (const path of ALL_DRAFTS) {
      expect(t.workingDocsRepo.update).toHaveBeenCalledWith(path, expect.objectContaining({
        expectedVersion: 3, type: 'deep-dive-draft', taskId: null,
      }));
    }
  });

  it('drafts nothing is written to rules, priorities or voice', async () => {
    const t = setup({ openTask: true, docs: { [SUMMARY_PATH]: summaryDoc() } });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect((await t.read())?.status).toBe('delivered');

    const writes = [
      ...t.workingDocsRepo.create.mock.calls.map((c) => c[0].path),
      ...t.workingDocsRepo.update.mock.calls.map((c) => c[0]),
    ];
    expect(writes).toHaveLength(3);
    for (const path of writes) expect(path.startsWith(DIR)).toBe(true);
    expect(t.executiveProfile.update).not.toHaveBeenCalled();
    expect(t.officeIdentity.update).not.toHaveBeenCalled();

    // Drafting gets the router deps by name, and never a mailbox client.
    const draftDeps = t.draft.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(Object.keys(draftDeps).sort()).toEqual(['bus', 'estimateCost', 'logger', 'modelRegistry', 'modelRouter', 'providerRouter']);
    // It reads what is already established: preferences and the working-hours fact.
    const inputs = t.draft.mock.calls[0]![1];
    expect(inputs).toMatchObject({ workingHours: 'Weekdays 9-5', behavioralPreferences: '- No meetings before 10' });
  });

  it('records the spend of a failed draft before the run fails', async () => {
    const t = setup({
      openTask: true,
      docs: { [SUMMARY_PATH]: summaryDoc() },
      draft: async () => { throw new DraftError('deep-dive draft "working-rules" failed: empty response', 0.7); },
    });
    await t.seed(drafting);
    await runDeepDive(t.deps, drafting);
    expect(await t.read()).toMatchObject({ status: 'failed', spendUsd: 0.7, error: expect.stringContaining('empty response') });
    expect(t.notifyOperator).toHaveBeenCalledWith('onb-1', 'deep_dive_failed');
    expect(t.onboardingService.openSession).not.toHaveBeenCalled();
  });

  it('marks failed, notifies deep_dive_failed and notes the open onboarding task on error', async () => {
    const t = setup({ openTask: true, scan: async () => { throw new Error('grant revoked'); } });
    await t.seed();
    await runDeepDive(t.deps, running);
    expect(await t.read()).toMatchObject({ status: 'failed', error: 'grant revoked' });
    expect(t.notifyOperator).toHaveBeenCalledWith('onb-1', 'deep_dive_failed');
    expect(t.taskRepo.updateTask).toHaveBeenCalledWith('onb-1', {
      progressNote: 'Deep dive failed: no drafts are coming from it; its Review topics can be declined',
    });
    // The wake is what re-checks onboarding completion, which the running deep dive held.
    expect(t.scheduler.enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'onb-1', agentId: 'coordinator' }));
  });

  it('a failure after some drafts were written names them instead of saying none are coming', async () => {
    const first = ALL_DRAFTS[0]!;
    const t = setup({
      openTask: true,
      docs: { [SUMMARY_PATH]: summaryDoc(), [first]: { path: first, body: '# d', version: 1 } },
      draft: async () => { throw new DraftError('deep-dive draft "time-and-priorities" failed: empty response', 0); },
    });
    const resumed = { ...drafting, backfilled: 2, draftPaths: [first] };
    await t.seed(resumed);
    await runDeepDive(t.deps, resumed);
    expect((await t.read())?.status).toBe('failed');
    const note = (t.taskRepo.updateTask.mock.calls as unknown as [string, { progressNote: string }][])
      .find(([id]) => id === 'onb-1')![1].progressNote;
    expect(note).toContain(first);
    expect(note).not.toContain('no drafts are coming');
    expect(t.scheduler.enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'onb-1' }));
  });

  it('a Nylas outage (the real scan reads nothing) fails the run with deep_dive_failed', async () => {
    const t = setup({ openTask: true });
    const down = Object.assign(new Error('unavailable'), { statusCode: 503 });
    const deps: RunDeps = {
      ...t.deps,
      scan: undefined,
      sleep: async () => {},
      mailboxes: {
        list: async () => [{ id: 'personal', label: 'personal', address: 'ceo@acme.example.com', isDefault: true, triageStartAt: null }],
        ceoClient: async () => ({ listAllMessages: async () => { throw down; } }),
        calendarClient: async () => ({ listCalendars: async () => { throw down; } }),
      } as never,
    };
    await t.seed();
    await runDeepDive(deps, running);
    expect(await t.read()).toMatchObject({ status: 'failed', error: expect.stringMatching(/read nothing/) });
    expect(t.workingDocsRepo.create).not.toHaveBeenCalled();
    expect(t.notifyOperator).toHaveBeenCalledWith('onb-1', 'deep_dive_failed');
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

  it('stops without handing off when the run was superseded during drafting', async () => {
    const t = setup({ openTask: true, docs: { [SUMMARY_PATH]: summaryDoc() } });
    await t.seed(drafting);
    t.draft.mockImplementationOnce(async () => {
      await writeDeepDiveState(t.configStore, { ...running, status: 'scanning', startedAt: '2026-11-23T11:30:00.000Z' });
      return { drafts: { 'working-rules': '# d' }, spendUsd: 0.5 };
    });
    await runDeepDive(t.deps, drafting);
    expect(t.workingDocsRepo.create).not.toHaveBeenCalled();
    expect(t.onboardingService.openSession).not.toHaveBeenCalled();
    expect((await t.read())?.startedAt).toBe('2026-11-23T11:30:00.000Z');
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
    expect((await t.read())?.status).toBe('delivered');
  });

  it('touches updatedAt while a draft is being written', async () => {
    let clock = NOW;
    const t = setup({ openTask: true, now: () => clock, heartbeatMs: 5, docs: { [SUMMARY_PATH]: summaryDoc() } });
    await t.seed(drafting);
    t.draft.mockImplementationOnce(async () => {
      clock = new Date(NOW.getTime() + 10 * 60_000);
      await vi.waitFor(() => {
        expect(t.written.some((s) => s.status === 'drafting' && s.updatedAt === clock.toISOString())).toBe(true);
      });
      return { drafts: { 'working-rules': '# d' }, spendUsd: 0.5 };
    });
    await runDeepDive(t.deps, drafting);
    expect((await t.read())?.status).toBe('delivered');
  });
});

describe('DeepDiveService with the real pipeline', () => {
  it('resumeAtBoot resumes a fresh scanning run to delivered', async () => {
    const t = setup();
    await t.seed({ updatedAt: new Date(NOW.getTime() - 60_000).toISOString() });
    const svc = new DeepDiveService({ ...t.deps });
    expect(await svc.resumeAtBoot()).toBe(true);
    await vi.waitFor(async () => {
      expect((await t.read())?.status).toBe('delivered');
    });
    expect(t.scan).toHaveBeenCalledTimes(1);
    // A delivered run is finished: neither boot nor the watcher fires it again.
    expect(await svc.resumeAtBoot()).toBe(false);
    expect(await svc.resumeIfStalled(new Date(NOW.getTime() + 24 * 3_600_000))).toBe(false);
  });
});
