import { describe, expect, it } from 'vitest';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import { collectActivityRefs, projectActivity, type ActivityRows, type ProjectionContext } from '../../../src/activity/projection.js';
import { buildCatalog, type LearnedDescriber } from '../../../src/activity/learned-describers.js';

const T0 = new Date('2026-10-24T13:00:00.000Z');
let seq = 0;

function row(overrides: Partial<AuditLogRow> & Pick<AuditLogRow, 'eventType'>): AuditLogRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    timestamp: new Date(T0.getTime() + seq * 1000),
    sourceLayer: 'agent',
    sourceId: 'coordinator',
    conversationId: 'conv-1',
    taskId: null,
    parentEventId: null,
    payload: {},
    action: null,
    outcome: null,
    targetType: null,
    targetId: null,
    initiatorType: null,
    initiatorId: null,
    entryHash: null,
    ...overrides,
  };
}

function task(id: string, payload: Record<string, unknown> = {}, overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return row({
    id,
    eventType: 'agent.task',
    timestamp: T0,
    payload: { agentId: 'coordinator', channelId: 'email', content: 'Please handle this private request', ...payload },
    ...overrides,
  });
}

/** A tool.invoke + tool.result pair under `taskId`. */
function toolCall(
  taskId: string,
  toolName: string,
  input: Record<string, unknown>,
  result: { success: true; data: unknown } | { success: false; error: string; errorType?: string },
  at?: Date,
): AuditLogRow[] {
  const invoke = row({ eventType: 'tool.invoke', parentEventId: taskId, payload: { toolName, input, taskEventId: taskId }, ...(at ? { timestamp: at } : {}) });
  const res = row({
    eventType: 'tool.result',
    parentEventId: invoke.id,
    outcome: result.success ? 'success' : 'failure',
    payload: { toolName, result },
    ...(at ? { timestamp: new Date(at.getTime() + 500) } : {}),
  });
  return [invoke, res];
}

function response(taskId: string, content: string, extra: Record<string, unknown> = {}, at?: Date): AuditLogRow {
  return row({ eventType: 'agent.response', parentEventId: taskId, payload: { agentId: 'coordinator', content, ...extra }, ...(at ? { timestamp: at } : {}) });
}

function ctx(overrides: Partial<ProjectionContext> = {}): ProjectionContext {
  return {
    name: () => null,
    timezone: 'America/Toronto',
    jobLabel: () => null,
    autonomyRows: [],
    ...overrides,
  };
}

function rows(roots: AuditLogRow[], children: AuditLogRow[], delegated: AuditLogRow[] = []): ActivityRows {
  return { roots, delegated, children };
}

const TOOL_NAMES = /config-store|executive-profile-get|ceo-inbox-|calendar-|web-search|web-fetch|email-|delegate/;

describe('projectActivity', () => {
  it('renders a ceo-inbox job of plumbing and reads as one item with no tool names', () => {
    const root = task('t1', { agentId: 'ceo-inbox', channelId: 'internal' });
    const children = [
      ...toolCall('t1', 'executive-profile-get', {}, { success: true, data: {} }),
      ...toolCall('t1', 'config-store', { key: 'a' }, { success: true, data: {} }),
      ...toolCall('t1', 'config-store', { key: 'b' }, { success: true, data: {} }),
      ...toolCall('t1', 'ceo-inbox-search', { query: 'x' }, { success: true, data: {} }),
      ...toolCall('t1', 'ceo-inbox-list', {}, { success: true, data: {} }),
      ...toolCall('t1', 'ceo-inbox-archive', { message_id: 'm1' }, { success: true, data: { subject: 'Newsletter' } }),
    ];
    const items = projectActivity(rows([root], children), ctx());
    expect(items).toHaveLength(1);
    expect(items[0]!.headline).toBe('archived an email');
    expect(JSON.stringify(items[0])).not.toMatch(TOOL_NAMES);
  });

  it('renders the issue\'s plumbing-only ceo-inbox job as one item with no tool names', () => {
    const jobId = '0b8f2f8e-1f7a-4c3e-9a51-3f0e2a1d4c56';
    const root = task('t1', { agentId: 'ceo-inbox', channelId: 'scheduler' }, { conversationId: `scheduler:${jobId}:run-1` });
    const children = [
      ...toolCall('t1', 'executive-profile-get', {}, { success: true, data: {} }),
      ...toolCall('t1', 'config-store', { key: 'a' }, { success: true, data: {} }),
      ...toolCall('t1', 'config-store', { key: 'b' }, { success: true, data: {} }),
      ...toolCall('t1', 'ceo-inbox-search', { query: 'x' }, { success: true, data: {} }),
      ...toolCall('t1', 'ceo-inbox-list', {}, { success: true, data: {} }),
    ];
    const items = projectActivity(rows([root], children), ctx({ jobLabel: () => 'Inbox triage' }));
    expect(items).toHaveLength(1);
    expect(items[0]!.headline).toBe('Inbox triage: no action needed');
    expect(items[0]!.details).toEqual([]);
    expect(JSON.stringify(items[0])).not.toMatch(TOOL_NAMES);
  });

  it('renders a successful draft reply with the contact name', () => {
    const root = task('t1');
    const children = toolCall('t1', 'ceo-inbox-draft-reply', { reply_to_message_id: 'm', body: 'b' }, {
      success: true, data: { to: [{ email: 'john@example.com' }] },
    });
    const r = rows([root], children);
    expect([...collectActivityRefs(r).names]).toEqual(['email:john@example.com']);
    const items = projectActivity(r, ctx({ name: (ref) => (ref === 'email:john@example.com' ? 'John Doe' : null) }));
    expect(items[0]!.headline).toBe('drafted a reply to John Doe');
  });

  it('renders calendar-create-event with the date in the principal timezone', () => {
    const root = task('t1');
    const children = toolCall('t1', 'calendar-create-event', { title: 'Board Meeting', start: '2026-11-01T02:30:00Z' }, {
      success: true, data: { event: { title: 'Board Meeting', startTime: '2026-10-31T22:30:00-04:00' } },
    });
    expect(projectActivity(rows([root], children), ctx())[0]!.headline).toBe('scheduled “Board Meeting” on Oct 31');
  });

  it('renders a web-only job as a research rollup', () => {
    const root = task('t1', { channelId: 'http' });
    const start = T0;
    const children = [
      ...toolCall('t1', 'web-search', { query: 'a' }, { success: true, data: {} }, new Date(start.getTime() + 60_000)),
      ...toolCall('t1', 'web-search', { query: 'b' }, { success: true, data: {} }, new Date(start.getTime() + 120_000)),
      ...toolCall('t1', 'web-fetch', { url: 'https://x' }, { success: true, data: {} }, new Date(start.getTime() + 180_000)),
      response('t1', 'Here is what I found', {}, new Date(start.getTime() + 30 * 60_000)),
    ];
    expect(projectActivity(rows([root], children), ctx())[0]!.headline).toBe('researched for 30 min (2 searches, 1 page)');
  });

  it('uses the persisted summary for a conversational job, and the generic line without one', () => {
    const withSummary = task('t1', { channelId: 'http' });
    const without = task('t2', { channelId: 'http' });
    const children = [
      response('t1', 'Idea one… idea two…'),
      row({ eventType: 'activity.summary', parentEventId: 't1', payload: { summary: 'provided two essay ideas', taskEventId: 't1' } }),
      response('t2', 'Sure, it is at 3pm.'),
    ];
    const items = projectActivity(rows([withSummary, without], children), ctx());
    expect(items.map((i) => i.headline)).toEqual(['provided two essay ideas', 'answered a question']);
  });

  it('renders the issue\'s plumbing-only ceo-inbox job, unscheduled, as one item with no tool names', () => {
    const root = task('t1', { agentId: 'ceo-inbox', channelId: 'internal' });
    const children = [
      ...toolCall('t1', 'executive-profile-get', {}, { success: true, data: {} }),
      ...toolCall('t1', 'config-store', { key: 'a' }, { success: true, data: {} }),
      ...toolCall('t1', 'config-store', { key: 'b' }, { success: true, data: {} }),
      ...toolCall('t1', 'ceo-inbox-search', { query: 'x' }, { success: true, data: {} }),
      ...toolCall('t1', 'ceo-inbox-list', {}, { success: true, data: {} }),
    ];
    const items = projectActivity(rows([root], children), ctx());
    expect(items).toHaveLength(1);
    expect(items[0]!.headline).toBe('checked the inbox');
    expect(JSON.stringify(items[0])).not.toMatch(TOOL_NAMES);
  });

  it('names a lookup-only job by what it read', () => {
    const cal = task('t1');
    const other = task('t2');
    const children = [
      ...toolCall('t1', 'calendar-list-events', {}, { success: true, data: {} }),
      ...toolCall('t2', 'config-store', {}, { success: true, data: {} }),
      response('t2', 'NO_REPLY', { suppressDelivery: true }),
    ];
    expect(projectActivity(rows([cal, other], children), ctx()).map((i) => i.headline))
      .toEqual(['checked the calendar', 'looked into a request']);
  });

  it('drops a job with no successful tool call and no reply', () => {
    const root = task('t1');
    const children = [
      ...toolCall('t1', 'config-store', {}, { success: false, error: 'x' }),
      response('t1', 'NO_REPLY', { suppressDelivery: true }),
    ];
    expect(projectActivity(rows([root], children), ctx())).toEqual([]);
  });

  it('does not count failed web calls as research', () => {
    const root = task('t1', { channelId: 'http' });
    const children = [
      ...toolCall('t1', 'web-search', { query: 'a' }, { success: false, error: 'rate limited' }),
      ...toolCall('t1', 'web-search', { query: 'b' }, { success: true, data: {} }),
      response('t1', 'Found it.'),
    ];
    expect(projectActivity(rows([root], children), ctx())[0]!.headline).toBe('researched for 1 min (1 search)');
    const onlyFailed = task('t2', { channelId: 'http' });
    const failedChildren = [
      ...toolCall('t2', 'web-search', { query: 'a' }, { success: false, error: 'rate limited' }),
      response('t2', 'I could not search right now.'),
    ];
    expect(projectActivity(rows([onlyFailed], failedChildren), ctx())[0]!.headline).toBe('answered a question');
  });

  it('shows a failed consequential action as a failure line', () => {
    const root = task('t1');
    const children = [
      ...toolCall('t1', 'email-send', { to: 'c-1', body: 'secret' }, { success: false, error: 'Nylas 500' }),
      ...toolCall('t1', 'ceo-inbox-archive', { message_id: 'm' }, { success: true, data: {} }),
    ];
    const item = projectActivity(rows([root], children), ctx({ name: (r) => (r === 'c-1' ? 'Jane Roe' : null) }))[0]!;
    expect(item.headline).toBe('archived an email');
    expect(item.details).toContain("couldn't email Jane Roe");
    expect(item.outcome).toBe('partial');
    // The raw provider error stays out of the feed.
    expect(JSON.stringify(item)).not.toContain('Nylas 500');
  });

  describe('policy holds (#2587)', () => {
    const HOLD = { success: false as const, error: 'Held for the principal: commits to a meeting time.', errorType: 'POLICY_HOLD' };
    const named = ctx({ name: (r) => (r === 'c-1' ? 'Jane Roe' : null) });

    it('shows a hold-only job as held for you, not failed', () => {
      const root = task('t1');
      const children = toolCall('t1', 'email-send', { to: 'c-1' }, HOLD);
      const item = projectActivity(rows([root], children), named)[0]!;
      expect(item.headline).toBe("didn't email Jane Roe: held for you");
      expect(item.outcome).toBe('success');
      // The guard's reason text stays out of the feed, as a failure's does.
      expect(JSON.stringify(item)).not.toContain('commits to a meeting time');
    });

    it('keeps a hold beside a success a success, with the hold as a detail', () => {
      const root = task('t1');
      const children = [
        ...toolCall('t1', 'ceo-inbox-archive', { message_id: 'm' }, { success: true, data: {} }),
        ...toolCall('t1', 'email-send', { to: 'c-1' }, HOLD),
      ];
      const item = projectActivity(rows([root], children), named)[0]!;
      expect(item.headline).toBe('archived an email');
      expect(item.details).toEqual(["didn't email Jane Roe: held for you"]);
      expect(item.outcome).toBe('success');
    });

    it('still fails a job whose real failure sits beside a hold', () => {
      const root = task('t1');
      const children = [
        ...toolCall('t1', 'email-send', { to: 'c-1' }, HOLD),
        ...toolCall('t1', 'calendar-create-event', { title: 'Lunch' }, { success: false, error: 'Nylas 503' }),
      ];
      const item = projectActivity(rows([root], children), named)[0]!;
      expect(item.outcome).toBe('failed');
      // Failures lead; the hold follows.
      expect(item.headline).toBe("couldn't schedule “Lunch”");
      expect(item.details).toEqual(["didn't email Jane Roe: held for you"]);
    });

    it('reads the hold from errorType only, never from the error text', () => {
      const root = task('t1');
      const children = toolCall('t1', 'email-send', { to: 'c-1' }, { success: false, error: 'Held for the principal.' });
      const item = projectActivity(rows([root], children), named)[0]!;
      expect(item.headline).toBe("couldn't email Jane Roe");
      expect(item.outcome).toBe('failed');
    });

    it('says a scheduled job with only a hold did something, not "no action needed"', () => {
      const jobId = '0b8f2f8e-1f7a-4c3e-9a51-3f0e2a1d4c56';
      const root = task('t1', { agentId: 'ceo-inbox', channelId: 'scheduler' }, { conversationId: `scheduler:${jobId}:run-1` });
      const children = toolCall('t1', 'email-send', { to: 'c-1' }, HOLD);
      const item = projectActivity(rows([root], children), ctx({ ...named, jobLabel: () => 'Inbox triage' }))[0]!;
      expect(item.headline).toBe('Inbox triage');
      expect(item.details).toEqual(["didn't email Jane Roe: held for you"]);
      expect(item.outcome).toBe('success');
    });
  });

  it('marks a job failed when its only action failed', () => {
    const root = task('t1');
    const children = toolCall('t1', 'calendar-create-event', { title: 'Lunch' }, { success: false, error: 'conflict' });
    const item = projectActivity(rows([root], children), ctx())[0]!;
    expect(item.headline).toBe("couldn't schedule “Lunch”");
    expect(item.outcome).toBe('failed');
  });

  it('labels autonomy from autonomy_action_log by task id', () => {
    const root = task('t1');
    const children = toolCall('t1', 'email-send', { to: 'c-1' }, { success: true, data: {} });
    const autonomyRows = [
      { taskId: 't1', toolName: 'email-send', outcome: 'approved', conversationId: 'conv-1', createdAt: T0 },
    ] as unknown as ActionLogRow[];
    expect(projectActivity(rows([root], children), ctx({ autonomyRows }))[0]!.autonomy).toBe('approved');
    const autonomous = [{ ...autonomyRows[0]!, outcome: 'success' }] as ActionLogRow[];
    expect(projectActivity(rows([root], children), ctx({ autonomyRows: autonomous }))[0]!.autonomy).toBe('autonomous');
    expect(projectActivity(rows([root], children), ctx())[0]!.autonomy).toBeNull();
  });

  it('puts delegated specialist work under the root job', () => {
    const root = task('t1', { channelId: 'signal' });
    const specialist = task('s1', {
      agentId: 'calendar', channelId: 'internal',
      metadata: { delegationOrigin: { taskEventId: 't1', conversationId: 'conv-1' } },
    }, { conversationId: 'delegate-x' });
    const nested = task('s2', {
      agentId: 'contacts', channelId: 'internal',
      metadata: { delegationOrigin: { taskEventId: 's1' } },
    }, { conversationId: 'delegate-y' });
    const children = [
      ...toolCall('t1', 'delegate', { agent: 'calendar', task: 'book it' }, { success: true, data: {} }),
      ...toolCall('s1', 'calendar-create-event', { title: 'Board Meeting', start: '2026-10-31T14:00:00Z' }, { success: true, data: {} }),
      ...toolCall('s2', 'contact-create', { name: 'Jane Roe' }, { success: true, data: { display_name: 'Jane Roe' } }),
      response('t1', 'Booked.'),
    ];
    const items = projectActivity(rows([root], children, [nested, specialist]), ctx());
    expect(items).toHaveLength(1);
    expect(items[0]!.actor).toBe('coordinator');
    expect(items[0]!.headline).toBe('scheduled an event, added a contact');
    expect(items[0]!.details).toEqual(['scheduled “Board Meeting” on Oct 31', 'added Jane Roe to contacts']);
    expect(JSON.stringify(items)).not.toMatch(/handed off/);
  });

  it('heads a scheduled job with its label and counts, and links to the job', () => {
    const jobId = '0b8f2f8e-1f7a-4c3e-9a51-3f0e2a1d4c55';
    const root = task('t1', { agentId: 'ceo-inbox', channelId: 'scheduler' }, { conversationId: `scheduler:${jobId}:run-1` });
    const children = [
      ...Array.from({ length: 3 }, (_, i) => toolCall('t1', 'ceo-inbox-archive', { message_id: `m${i}` }, { success: true, data: {} })).flat(),
      ...toolCall('t1', 'ceo-inbox-draft-reply', {}, { success: true, data: { to: [{ email: 'a@x.com' }] } }),
      ...toolCall('t1', 'ceo-inbox-draft-reply', {}, { success: true, data: { to: [{ email: 'b@x.com' }] } }),
    ];
    const r = rows([root], children);
    expect([...collectActivityRefs(r).jobIds]).toEqual([jobId]);
    const item = projectActivity(r, ctx({ jobLabel: (id) => (id === jobId ? "Triage Joseph's inbox" : null) }))[0]!;
    expect(item.headline).toBe("Triage Joseph's inbox: drafted 2 replies, archived 3 emails");
    expect(item.details).toEqual(['drafted a reply to a@x.com', 'drafted a reply to b@x.com']);
    expect(item.link).toEqual({ kind: 'job', jobId });
  });

  it('does not call a scheduled run "no action needed" when its only action has no tally', () => {
    const jobId = '0b8f2f8e-1f7a-4c3e-9a51-3f0e2a1d4c57';
    const root = task('t1', { agentId: 'learning', channelId: 'scheduler' }, { conversationId: `scheduler:${jobId}:run-1` });
    const children = toolCall('t1', 'voice-learn', {}, { success: true, data: { proposed: true } });
    const item = projectActivity(rows([root], children), ctx({ jobLabel: () => 'Learn from sent mail' }))[0]!;
    expect(item.headline).toBe('Learn from sent mail: proposed a writing-voice update');
  });

  it('keeps untallied actions in a multi-action headline', () => {
    const root = task('t1');
    const children = [
      ...toolCall('t1', 'contact-rename', { contact_id: 'c', display_name: 'Jane Roe' }, { success: true, data: {} }),
      ...toolCall('t1', 'email-send', { to: 'c-1' }, { success: true, data: {} }),
    ];
    expect(projectActivity(rows([root], children), ctx())[0]!.headline).toBe('renamed a contact to Jane Roe, sent an email');
  });

  it('links a conversational job to a replay window around it', () => {
    const root = task('t1', { channelId: 'http' });
    const item = projectActivity(rows([root], [response('t1', 'hi')]), ctx())[0]!;
    expect(item.link).toMatchObject({ kind: 'conversation', conversationId: 'conv-1' });
    if (item.link?.kind !== 'conversation') throw new Error('expected a conversation link');
    expect(Date.parse(item.link.from)).toBeLessThan(T0.getTime());
    expect(Date.parse(item.link.to)).toBeGreaterThan(T0.getTime());
  });

  it('keeps every email and message body out of the items', () => {
    const BODY = 'CONFIDENTIAL-BODY-TEXT';
    const root = task('t1', { content: `${BODY} in the request` });
    const children = [
      ...toolCall('t1', 'email-send', { to: 'c-1', subject: 'Hi', body: BODY }, { success: true, data: { to: 'x@y.com', subject: 'Hi' } }),
      ...toolCall('t1', 'email-draft-save', { to: 'c-1', subject: 'S', body: BODY }, { success: true, data: { draft_id: 'd' } }),
      ...toolCall('t1', 'ceo-inbox-draft-reply', { reply_to_message_id: 'm', body: BODY }, { success: true, data: { to: [{ email: 'x@y.com' }], snippet: BODY } }),
      ...toolCall('t1', 'signal-send', { recipient: 'c-1', message: BODY }, { success: true, data: {} }),
      ...toolCall('t1', 'doc-write', { path: 'notes/a.md', mode: 'create', body: BODY }, {
        success: true, data: { action: 'created', document: { path: 'notes/a.md', body: BODY, frontmatter: {} } },
      }),
      ...toolCall('t1', 'image-generate', { prompt: BODY }, { success: true, data: { revised_prompt: BODY } }),
      response('t1', `${BODY} in the reply`),
    ];
    const conversational = task('t2', { channelId: 'http', content: BODY });
    const items = projectActivity(rows([root, conversational], [...children, response('t2', BODY)]), ctx());
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).not.toContain(BODY);
  });
});

describe('projectActivity with learned describers (ADR-059)', () => {
  function learned(overrides: Partial<LearnedDescriber> = {}): LearnedDescriber {
    return {
      agentId: 'expenses', toolName: 'sheet-append', effect: 'write', verb: 'logged', one: 'an expense', many: 'expenses',
      attempt: 'log an expense', descriptionHash: 'h', source: 'learned', ...overrides,
    };
  }
  const sheetRead = learned({ toolName: 'sheet-read', effect: 'read', verb: 'checked', one: 'the expense sheet', many: 'the expense sheet', attempt: 'check the expense sheet' });
  const catalog = buildCatalog([learned(), sheetRead], ['custom-payment']);
  const UNDESCRIBED_NAMES = /sheet-append|sheet-read|custom-payment/;

  /** An internal job run by the expenses agent, with no reply. */
  function expensesTask(id: string): AuditLogRow {
    return task(id, { agentId: 'expenses', channelId: 'internal' });
  }

  it('shows a job whose only work is learned writes as a tally, not "looked into a request"', () => {
    const root = expensesTask('t1');
    const children = [
      ...toolCall('t1', 'sheet-read', {}, { success: true, data: {} }),
      ...toolCall('t1', 'sheet-append', { row: [1] }, { success: true, data: {} }),
      ...toolCall('t1', 'sheet-append', { row: [2] }, { success: true, data: {} }),
      ...toolCall('t1', 'sheet-append', { row: [3] }, { success: true, data: {} }),
    ];
    const [item] = projectActivity(rows([root], children), ctx({ catalog }));
    expect(item).toMatchObject({ headline: 'logged 3 expenses', outcome: 'success' });
    expect(JSON.stringify(item)).not.toMatch(UNDESCRIBED_NAMES);
  });

  it('keeps today\'s fallback without a catalog', () => {
    const root = expensesTask('t1');
    const children = [...toolCall('t1', 'sheet-append', {}, { success: true, data: {} })];
    expect(projectActivity(rows([root], children), ctx())[0]!.headline).toBe('looked into a request');
  });

  it('marks a failed learned write partial beside successes and failed alone', () => {
    const mixed = expensesTask('t1');
    const alone = expensesTask('t2');
    const children = [
      ...toolCall('t1', 'sheet-append', {}, { success: true, data: {} }),
      ...toolCall('t1', 'sheet-append', {}, { success: false, error: 'quota' }),
      ...toolCall('t2', 'sheet-append', {}, { success: false, error: 'quota' }),
    ];
    const items = projectActivity(rows([mixed, alone], children), ctx({ catalog }));
    expect(items.map((i) => [i.headline, i.outcome])).toEqual([
      ['logged an expense', 'partial'],
      ["couldn't log an expense", 'failed'],
    ]);
    expect(items[0]!.details).toContain("couldn't log an expense");
  });

  it('never makes a failed learned read a hiccup, and names a lookup-only job by its learned read', () => {
    const failedRead = expensesTask('t1');
    const lookup = expensesTask('t2');
    const children = [
      ...toolCall('t1', 'sheet-read', {}, { success: false, error: 'timeout' }),
      ...toolCall('t1', 'sheet-read', {}, { success: true, data: {} }),
      ...toolCall('t2', 'sheet-read', {}, { success: true, data: {} }),
    ];
    const items = projectActivity(rows([failedRead, lookup], children), ctx({ catalog }));
    expect(items.map((i) => [i.headline, i.outcome])).toEqual([
      ['checked the expense sheet', 'success'],
      ['checked the expense sheet', 'success'],
    ]);
  });

  it('keeps the inbox, calendar and contacts lines ahead of a learned read', () => {
    const root = expensesTask('t1');
    const children = [
      ...toolCall('t1', 'sheet-read', {}, { success: true, data: {} }),
      ...toolCall('t1', 'calendar-list-events', {}, { success: true, data: {} }),
    ];
    expect(projectActivity(rows([root], children), ctx({ catalog }))[0]!.headline).toBe('checked the calendar');
  });

  it('counts a known write with no row as "took N actions", and its failure', () => {
    const root = expensesTask('t1');
    const children = [
      ...toolCall('t1', 'custom-payment', {}, { success: true, data: {} }),
      ...toolCall('t1', 'custom-payment', {}, { success: true, data: {} }),
      ...toolCall('t1', 'custom-payment', {}, { success: false, error: 'declined' }),
    ];
    const [item] = projectActivity(rows([root], children), ctx({ catalog }));
    expect(item).toMatchObject({ headline: 'took 2 actions', outcome: 'partial' });
    expect(item!.details).toContain("couldn't finish an action");
    expect(JSON.stringify(item)).not.toMatch(UNDESCRIBED_NAMES);
  });

  it('leaves an undescribed tool with no row and no signal unnamed', () => {
    const root = expensesTask('t1');
    const children = [...toolCall('t1', 'mystery-tool', {}, { success: false, error: 'x' }), ...toolCall('t1', 'mystery-tool', {}, { success: true, data: {} })];
    expect(projectActivity(rows([root], children), ctx({ catalog }))[0]).toMatchObject({ headline: 'looked into a request', outcome: 'success' });
  });

  it('keys a delegated specialist\'s calls by the specialist, not the root agent', () => {
    const root = task('t1', { agentId: 'coordinator' });
    const delegated = task('t2', { agentId: 'expenses', metadata: { delegationOrigin: { taskEventId: 't1' } } });
    const children = [
      ...toolCall('t2', 'sheet-append', {}, { success: true, data: {} }),
      // The same tool from the coordinator has no row for that agent.
      ...toolCall('t1', 'sheet-append', {}, { success: true, data: {} }),
      response('t1', 'Done.'),
    ];
    const [item] = projectActivity(rows([root], children, [delegated]), ctx({ catalog }));
    expect(item!.headline).toBe('logged an expense');
  });

  it('lets a code describer win over a learned row for the same tool', () => {
    const codeTool = buildCatalog([learned({ toolName: 'email-archive', verb: 'binned', one: 'a thing', many: 'things' })], []);
    const root = expensesTask('t1');
    const children = [...toolCall('t1', 'email-archive', { messageId: 'm1' }, { success: true, data: {} })];
    expect(projectActivity(rows([root], children), ctx({ catalog: codeTool }))[0]!.headline).toBe('archived an email');
  });

  it('folds learned writes into a scheduled job\'s line', () => {
    const root = task('t1', { agentId: 'expenses', channelId: 'scheduler' }, { conversationId: 'scheduler:2b9f7c1e-4d3a-4f6b-9c8e-1a2b3c4d5e6f:run-1' });
    const children = [...toolCall('t1', 'sheet-append', {}, { success: true, data: {} })];
    const [item] = projectActivity(rows([root], children), ctx({ catalog, jobLabel: () => 'Weekly expenses' }));
    expect(item!.headline).toBe('Weekly expenses: logged an expense');
  });
});
