// Stubbed list/search results answer the question asked (#1956).
import { describe, expect, it } from 'vitest';
import { CaseToolState } from '../../shared/tool-state.js';
import { fillInputPlaceholders, matchesMailQuery, shapeStubResult } from '../../smoke/stub-filters.js';

const events = {
  displayTimezone: 'America/Toronto',
  events: [
    { id: 'a', title: 'Standup', startTime: '2026-10-07T08:30:00-04:00', endTime: '2026-10-07T09:00:00-04:00', participants: [] },
    { id: 'b', title: 'Partner call — Nexus', startTime: '2026-10-07T11:00:00-04:00', endTime: '2026-10-07T12:00:00-04:00', participants: [{ email: 'sarah.chen@nexus.example' }] },
    { id: 'c', title: 'All-hands', startTime: '2026-10-09T10:00:00-04:00', endTime: '2026-10-09T11:00:00-04:00', participants: [] },
  ],
};

describe('calendar-list-events', () => {
  it('keeps events overlapping the requested window and recounts', () => {
    const r = shapeStubResult('calendar-list-events', events, { timeMin: '2026-10-07T00:00:00-04:00', timeMax: '2026-10-08T00:00:00-04:00' }) as { events: Array<{ id: string }>; count: number };
    expect(r.events.map(e => e.id)).toEqual(['a', 'b']);
    expect(r.count).toBe(2);
  });

  it('filters by query and attendee', () => {
    expect((shapeStubResult('calendar-list-events', events, { query: 'nexus' }) as { events: unknown[] }).events).toHaveLength(1);
    expect((shapeStubResult('calendar-list-events', events, { attendeeEmail: 'Sarah.Chen@nexus.example' }) as { events: unknown[] }).events).toHaveLength(1);
  });
});

describe('calendar-find-free-time', () => {
  it('keeps windows inside the range that fit the duration', () => {
    const data = { freeWindows: [
      { start: '2026-10-05T11:00:00-04:00', end: '2026-10-05T11:30:00-04:00' },
      { start: '2026-10-05T15:00:00-04:00', end: '2026-10-05T17:00:00-04:00' },
      { start: '2026-10-09T12:00:00-04:00', end: '2026-10-09T14:00:00-04:00' },
    ] };
    const r = shapeStubResult('calendar-find-free-time', data, { timeMin: '2026-10-05T00:00:00-04:00', timeMax: '2026-10-06T00:00:00-04:00', duration: 45 }) as { freeWindows: Array<{ start: string }> };
    expect(r.freeWindows.map(w => w.start)).toEqual(['2026-10-05T15:00:00-04:00']);
  });
});

describe('mailbox', () => {
  const inbox = { messages: [
    { id: 'm1', from: [{ name: 'Priya Sharma', email: 'priya.sharma@curiatech.example' }], subject: 'Q2 board deck', snippet: 'Attached', unread: true },
    { id: 'm2', from: [{ name: 'Elena Ruiz', email: 'elena.ruiz@northstar.example' }], subject: 'Need to talk today', snippet: 'board matter', unread: false },
  ], count: 2 };

  it('matches from:, subject: and bare words, and ignores operators it cannot evaluate', () => {
    expect(matchesMailQuery(inbox.messages[0]!, 'from:priya has:attachment')).toBe(true);
    expect(matchesMailQuery(inbox.messages[0]!, 'subject:"board deck"')).toBe(true);
    expect(matchesMailQuery(inbox.messages[1]!, 'board is:unread')).toBe(true);
    expect(matchesMailQuery(inbox.messages[1]!, 'from:priya')).toBe(false);
  });

  it('search filters by query; list keeps unread unless asked otherwise', () => {
    expect((shapeStubResult('ceo-inbox-search', inbox, { query: 'from:elena' }) as { messages: Array<{ id: string }> }).messages.map(m => m.id)).toEqual(['m2']);
    expect((shapeStubResult('ceo-inbox-list', inbox, {}) as { messages: Array<{ id: string }> }).messages.map(m => m.id)).toEqual(['m1']);
    expect((shapeStubResult('ceo-inbox-list', inbox, { unread_only: false }) as { count: number }).count).toBe(2);
  });
});

describe('fillInputPlaceholders', () => {
  it('takes a whole-placeholder value as-is and embeds others as text', () => {
    expect(fillInputPlaceholders({ to: '{{input:to}}', subject: 'Re: {{input:subject}}', missing: '{{input:nope}}' }, { to: [{ email: 'a@b' }], subject: 'Hi' }))
      .toEqual({ to: [{ email: 'a@b' }], subject: 'Re: Hi', missing: null });
  });

  it('leaves tools without a filter unchanged apart from inputs', () => {
    expect(shapeStubResult('task-create', { title: '{{input:title}}', events: 'x' }, { title: 'Chase DD' })).toEqual({ title: 'Chase DD', events: 'x' });
  });
});

describe('CalendarState', () => {
  const base = { events: [
    { id: 'a', title: 'Standup', startTime: '2026-10-07T08:30:00-04:00', endTime: '2026-10-07T09:00:00-04:00' },
    { id: 'b', title: 'Review', startTime: '2026-10-07T13:00:00-04:00', endTime: '2026-10-07T14:00:00-04:00' },
  ] };
  const wed = { timeMin: '2026-10-07T00:00:00-04:00', timeMax: '2026-10-08T00:00:00-04:00' };
  const created = { event: { id: 'evt-created-0001', title: '{{input:title}}', startTime: '{{input:start}}', endTime: '{{input:end}}' } };

  it('shows a created event in later listings, with a distinct id per create', () => {
    const state = new CaseToolState();
    const first = shapeStubResult('calendar-create-event', created, { title: 'Airport', start: '2026-10-07T06:30:00-04:00', end: '2026-10-07T08:00:00-04:00' }, state) as { event: { id: string } };
    const second = shapeStubResult('calendar-create-event', created, { title: 'Recovery', start: '2026-10-07T15:00:00-04:00', end: '2026-10-07T17:00:00-04:00' }, state) as { event: { id: string } };
    expect(first.event.id).not.toBe(second.event.id);
    const listed = shapeStubResult('calendar-list-events', base, wed, state) as { events: Array<{ title: string }>; count: number };
    expect(listed.events.map(e => e.title)).toEqual(['Standup', 'Review', 'Airport', 'Recovery']);
    expect(listed.count).toBe(4);
  });

  it('applies updates and deletes to listed events', () => {
    const state = new CaseToolState();
    shapeStubResult('calendar-update-event', { event: {} }, { eventId: 'b', start: '2026-10-07T15:00:00-04:00', end: '2026-10-07T16:00:00-04:00' }, state);
    shapeStubResult('calendar-delete-event', { deleted: true }, { eventId: 'a' }, state);
    const listed = shapeStubResult('calendar-list-events', base, wed, state) as { events: Array<{ id: string; startTime: string }> };
    expect(listed.events).toEqual([expect.objectContaining({ id: 'b', startTime: '2026-10-07T15:00:00-04:00' })]);
  });

  it('keeps nothing without a state (stateless use)', () => {
    shapeStubResult('calendar-create-event', created, { title: 'X', start: '2026-10-07T06:30:00-04:00', end: '2026-10-07T07:00:00-04:00' });
    expect((shapeStubResult('calendar-list-events', base, wed) as { count: number }).count).toBe(2);
  });
});

describe('matchesMailQuery: ordinary Gmail queries', () => {
  const priya = { from: [{ name: 'Priya Sharma', email: 'priya.sharma@curiatech.example' }], subject: 'Q2 board deck', snippet: 'Attached' };
  const elena = { from: [{ name: 'Elena Ruiz', email: 'elena.ruiz@northstar.example' }], subject: 'Need to talk today', snippet: 'board matter' };

  it('treats OR as either side', () => {
    expect(matchesMailQuery(priya, 'from:priya OR from:daniel')).toBe(true);
    expect(matchesMailQuery(elena, 'from:priya OR from:daniel')).toBe(false);
  });

  it('excludes negated terms, and ignores negated operators it cannot evaluate', () => {
    expect(matchesMailQuery(priya, 'board -from:elena')).toBe(true);
    expect(matchesMailQuery(elena, 'board -from:elena')).toBe(false);
    expect(matchesMailQuery(priya, 'is:unread -category:promotions')).toBe(true);
  });

  it('ignores parentheses', () => {
    expect(matchesMailQuery(elena, '(from:elena OR from:priya) board')).toBe(true);
  });
});

const JOB_ID = '0f0f0f0f-0000-4000-8000-000000000001';

describe('SchedulerState', () => {
  const created = { jobId: JOB_ID };
  const empty = { jobs: [], count: 0, truncated: false, limit: 50, displayTimezone: 'America/Toronto' };
  const listed = {
    jobs: [{
      id: JOB_ID,
      agentId: 'coordinator',
      status: 'pending',
      cronExpr: '0 9 * * 1-5',
      timezone: 'America/Toronto',
      taskTitle: 'Weekday investor inbox check',
    }],
    count: 1,
    truncated: false,
    limit: 50,
  };

  it('shows a created job on a later list, and mints a new id when the stub id repeats', () => {
    const state = new CaseToolState();
    const first = shapeStubResult('scheduler-create', created, { task: 'Scan investor mail', cron_expr: '0 9 * * 1-5', timezone: 'America/Toronto' }, state) as { jobId: string };
    const second = shapeStubResult('scheduler-create', created, { task: 'Scan investor mail', cron_expr: '0 17 * * 1-5' }, state) as { jobId: string };
    expect(first.jobId).toBe(JOB_ID);
    expect(second.jobId).not.toBe(first.jobId);
    const jobs = (shapeStubResult('scheduler-list', empty, {}, state) as { jobs: Array<{ id: string; cronExpr: string; taskPreview: string }>; count: number }).jobs;
    expect(jobs.map(job => job.id)).toEqual([second.jobId, JOB_ID]);
    expect(jobs.map(job => job.cronExpr)).toEqual(['0 17 * * 1-5', '0 9 * * 1-5']);
    expect(jobs[1]!.taskPreview).toBe('Scan investor mail');
  });

  it('merges an edit onto a listed job and marks a cancel', () => {
    const state = new CaseToolState();
    shapeStubResult('scheduler-update', { jobId: JOB_ID, action: 'edit' }, { job_id: JOB_ID, action: 'edit', cron_expr: '0 10 * * 1-5' }, state);
    const edited = shapeStubResult('scheduler-list', listed, {}, state) as { jobs: Array<{ id: string; cronExpr: string; taskTitle: string; status: string }> };
    expect(edited.jobs).toEqual([expect.objectContaining({ id: JOB_ID, cronExpr: '0 10 * * 1-5', taskTitle: 'Weekday investor inbox check', status: 'pending' })]);
    // A status filter still finds the edited job. `pending` is a real status; `active` is not.
    const pending = shapeStubResult('scheduler-list', listed, { status: 'pending' }, state) as { jobs: Array<{ cronExpr: string }> };
    expect(pending.jobs).toEqual([expect.objectContaining({ cronExpr: '0 10 * * 1-5' })]);

    shapeStubResult('scheduler-cancel', { cancelled: true, jobId: JOB_ID }, { job_id: JOB_ID }, state);
    const after = shapeStubResult('scheduler-list', listed, {}, state) as { jobs: Array<{ status: string; cronExpr: string }> };
    expect(after.jobs).toEqual([expect.objectContaining({ status: 'cancelled', cronExpr: '0 10 * * 1-5' })]);
    const stillPending = shapeStubResult('scheduler-list', listed, { status: 'pending' }, state) as { jobs: unknown[] };
    expect(stillPending.jobs).toEqual([]);
  });

  it('filters a listing by status before the case has written anything', () => {
    const state = new CaseToolState();
    const data = {
      jobs: [
        { id: 'a', status: 'pending', agentId: 'coordinator', cronExpr: '0 9 * * 1' },
        { id: 'b', status: 'paused', agentId: 'research', cronExpr: '0 10 * * 1' },
      ],
      count: 2,
      limit: 50,
    };
    const paused = shapeStubResult('scheduler-list', data, { status: 'paused' }, state) as { jobs: Array<{ id: string }>; count: number };
    expect(paused.jobs.map(job => job.id)).toEqual(['b']);
    expect(paused.count).toBe(1);
    const research = shapeStubResult('scheduler-list', data, { agent_id: 'research' }, state) as { jobs: Array<{ id: string }> };
    expect(research.jobs.map(job => job.id)).toEqual(['b']);
    expect(shapeStubResult('scheduler-list', data, {}, state)).toEqual(data);
  });

  it('lets the later of pause and resume set the status', () => {
    const state = new CaseToolState();
    shapeStubResult('scheduler-update', {}, { job_id: JOB_ID, action: 'pause' }, state);
    shapeStubResult('scheduler-update', {}, { job_id: JOB_ID, action: 'resume' }, state);
    const jobs = (shapeStubResult('scheduler-list', listed, {}, state) as { jobs: Array<{ status: string }> }).jobs;
    expect(jobs[0]?.status).toBe('pending');
  });

  it('lets a listing stub override the create, then still applies a later edit', () => {
    const state = new CaseToolState();
    shapeStubResult('scheduler-create', created, { task: 'Scan investor mail', cron_expr: '0 8 * * 1-5' }, state);
    const before = shapeStubResult('scheduler-list', listed, {}, state) as { jobs: Array<{ cronExpr: string; taskTitle: string }> };
    // The turn stub's 9am job wins over the create's 8am cron. Its title stays.
    expect(before.jobs).toEqual([expect.objectContaining({ cronExpr: '0 9 * * 1-5', taskTitle: 'Weekday investor inbox check' })]);
    shapeStubResult('scheduler-update', { jobId: JOB_ID }, { job_id: JOB_ID, action: 'edit', cron_expr: '0 10 * * 1-5', task_payload: { task: 'Scan investor mail at ten' } }, state);
    const after = shapeStubResult('scheduler-list', listed, {}, state) as { jobs: Array<{ cronExpr: string; taskPreview: string; taskTitle: string }> };
    expect(after.jobs[0]).toEqual(expect.objectContaining({ cronExpr: '0 10 * * 1-5', taskPreview: 'Scan investor mail at ten', taskTitle: 'Weekday investor inbox check' }));
  });

  it('leaves a listing with no jobs array as scripted', () => {
    const state = new CaseToolState();
    shapeStubResult('scheduler-create', created, { task: 'Scan', cron_expr: '0 9 * * 1' }, state);
    expect(shapeStubResult('scheduler-list', { note: 'frozen' }, {}, state)).toEqual({ note: 'frozen' });
  });

  it('keeps nothing without a state', () => {
    shapeStubResult('scheduler-create', created, { task: 'Scan', cron_expr: '0 9 * * 1-5' });
    expect(shapeStubResult('scheduler-list', empty, {})).toEqual(empty);
  });
});

describe('DraftState', () => {
  const compose = { draft_id: 'draft-0002', subject: '{{input:subject}}', to: '{{input:to}}', cc: [] };

  it('returns a composed draft, including a later edit, from ceo-inbox-read', () => {
    const state = new CaseToolState();
    shapeStubResult('ceo-inbox-draft-compose', compose, { subject: 'Hello', to: ['maya@techto.example'], body: 'See you Tuesday.' }, state);
    shapeStubResult('ceo-inbox-draft-edit', { draft_id: 'draft-0002' }, { draft_id: 'draft-0002', body: 'See you Wednesday.', cc: ['priya@curiatech.example'] }, state);
    expect(state.drafts.read({ draft_id: 'draft-0002' })).toEqual(expect.objectContaining({
      id: 'draft-0002',
      is_draft: true,
      subject: 'Hello',
      to: [{ email: 'maya@techto.example' }],
      cc: [{ email: 'priya@curiatech.example' }],
      body_plain: 'See you Wednesday.',
    }));
  });

  it('records a reply body the stub return does not echo', () => {
    const state = new CaseToolState();
    shapeStubResult('ceo-inbox-draft-reply', { draft_id: 'draft-0001', subject: 'Re: Board', to: [{ email: 'elena@northstar.example' }], cc: [] }, { reply_to_message_id: 'm1', body: 'I can talk at 2.' }, state);
    expect(state.drafts.read({ draft_id: 'draft-0001' })).toEqual(expect.objectContaining({
      subject: 'Re: Board',
      body_plain: 'I can talk at 2.',
      to: [{ email: 'elena@northstar.example' }],
    }));
  });

  it('does not record a shadow draft that returns no draft id', () => {
    const state = new CaseToolState();
    shapeStubResult('ceo-inbox-shadow-draft', { captured: true }, { source_message_id: 'm1', body: 'shadow' }, state);
    shapeStubResult('ceo-inbox-shadow-draft', { captured: true, draft_id: 'draft-0001' }, { source_message_id: 'm1', subject: 'Hi', body: 'shadow' }, state);
    expect(state.drafts.read({ draft_id: 'draft-0001' })).toBeUndefined();
  });

  it('does not invent a draft when an edit names an id this case never wrote', () => {
    const state = new CaseToolState();
    shapeStubResult('ceo-inbox-draft-edit', { draft_id: 'draft-0001' }, { draft_id: 'draft-0001', body: 'Guessed', subject: 'Hello' }, state);
    expect(state.drafts.read({ draft_id: 'draft-0001' })).toBeUndefined();
  });
});

describe('TaskState', () => {
  const created = { task_id: '0e5d6c7b-1a2b-4c3d-8e9f-000000000001', title: '{{input:title}}', status: 'open', owner: '{{input:owner}}', priority: 3, tags: [] };
  const empty = { tasks: [], count: 0, displayTimezone: 'America/Toronto' };

  it('shows a created task, then an update and a completion', () => {
    const state = new CaseToolState();
    const made = shapeStubResult('task-create', created, { title: 'Chase the deck', owner: 'curia' }, state) as { task_id: string };
    shapeStubResult('task-update', { task_id: made.task_id }, { task_id: made.task_id, priority: 1, progress_note: 'Asked Priya' }, state);
    const open = shapeStubResult('task-list', empty, { status: 'open' }, state) as { tasks: Array<{ title: string; priority: number; last_progress_note: string }>; count: number };
    expect(open.tasks).toEqual([expect.objectContaining({ title: 'Chase the deck', priority: 1, last_progress_note: 'Asked Priya' })]);
    expect(open.count).toBe(1);

    shapeStubResult('task-complete', { task_id: made.task_id, status: 'done' }, { task_id: made.task_id }, state);
    expect((shapeStubResult('task-list', empty, { status: 'open' }, state) as { tasks: unknown[] }).tasks).toEqual([]);
    expect((shapeStubResult('task-list', empty, { status: 'done' }, state) as { tasks: Array<{ status: string }> }).tasks).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  it('filters a listing by owner and tag before the case has written anything', () => {
    const state = new CaseToolState();
    const data = {
      tasks: [
        { task_id: 'a', title: 'Deck', status: 'open', owner: 'ceo', tags: ['board'] },
        { task_id: 'b', title: 'Inbox', status: 'open', owner: 'curia', tags: ['mail'] },
      ],
      count: 2,
    };
    const board = shapeStubResult('task-list', data, { tag: 'board' }, state) as { tasks: Array<{ task_id: string }>; count: number };
    expect(board.tasks.map(task => task.task_id)).toEqual(['a']);
    expect(board.count).toBe(1);
    const curia = shapeStubResult('task-list', data, { owner: 'curia' }, state) as { tasks: Array<{ task_id: string }> };
    expect(curia.tasks.map(task => task.task_id)).toEqual(['b']);
    expect(shapeStubResult('task-list', data, {}, state)).toEqual(data);
  });

  it('lets a listing stub override the create, and leaves a list with no tasks array as scripted', () => {
    const state = new CaseToolState();
    const id = '0e5d6c7b-1a2b-4c3d-8e9f-000000000001';
    shapeStubResult('task-create', created, { title: 'From the create', owner: 'curia' }, state);
    const stub = { tasks: [{ task_id: id, title: 'From the turn', status: 'open', owner: 'ceo', priority: 3, tags: ['board'] }] };
    const listed = shapeStubResult('task-list', stub, {}, state) as { tasks: Array<{ title: string; owner: string }> };
    expect(listed.tasks).toEqual([expect.objectContaining({ title: 'From the turn', owner: 'ceo' })]);
    expect(shapeStubResult('task-list', { note: 'frozen' }, {}, state)).toEqual({ note: 'frozen' });
  });
});
