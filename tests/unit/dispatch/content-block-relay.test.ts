import { describe, it, expect } from 'vitest';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
import {
  CONTENT_BLOCK_MAX_RETRIES,
  PRIOR_TURN_RESULTS_LIMIT,
  PRIOR_TURN_RESULT_MAX_CHARS,
  PRIOR_TURN_TOTAL_MAX_CHARS,
  buildContentBlockRewriteTask,
  clipMiddleCodePoints,
  isContentFilterRewriteable,
  priorTurnActionsFromRows,
  summarizeBlockFindings,
} from '../../../src/dispatch/content-block-relay.js';
import type { PriorTurnActions, PriorTurnCall } from '../../../src/agents/prompts/prior-turn-actions.js';

describe('content-block-relay', () => {
  it('shows the quoted claims of a band bounce to the rewriting agent (#2159)', () => {
    const summary = summarizeBlockFindings([
      { rule: 'ungrounded-claim', detail: 'These claims about the principal are not backed: "I am away."' },
      { rule: 'unneeded-disclosure', detail: 'This message shares details its purpose does not need: "account 4417".' },
    ]);
    expect(summary).toContain('I am away.');
    expect(summary).toContain('account 4417');
  });

  it('shows the PII and placeholder guidance of a band bounce to the rewriting agent (#2312)', () => {
    const summary = summarizeBlockFindings([
      { rule: 'pii-not-authorized', detail: 'This message shares personal details nothing authorizes for this recipient: phone number. Rewrite it without them.' },
      { rule: 'redaction-token', detail: 'This message contains a redaction placeholder. Rewrite it with the real content or without that part.' },
      { rule: 'secret-pattern', detail: 'matched sk-live-123' },
    ]);
    expect(summary).toContain('pii-not-authorized: This message shares personal details nothing authorizes for this recipient: phone number.');
    expect(summary).toContain('redaction-token: This message contains a redaction placeholder.');
    // Other Stage-1 rules still show the rule name only.
    expect(summary).not.toContain('sk-live-123');
  });

  it('treats content-filter findings as rewriteable', () => {
    expect(isContentFilterRewriteable([{ rule: 'llm-judge-audience-leak', detail: 'named internal agent' }])).toBe(true);
  });

  it('treats no-reply-recipient as terminal (not rewriteable)', () => {
    expect(isContentFilterRewriteable([{ rule: 'no-reply-recipient', detail: 'automated' }])).toBe(false);
  });

  it('treats filter-error as terminal', () => {
    expect(isContentFilterRewriteable([{ rule: 'filter-error', detail: 'crash' }])).toBe(false);
  });

  it('treats pii_redactor_error as terminal', () => {
    expect(isContentFilterRewriteable([{ rule: 'pii_redactor_error', detail: 'crash' }])).toBe(false);
  });

  it('returns false when terminal and non-terminal findings are mixed', () => {
    expect(isContentFilterRewriteable([
      { rule: 'llm-judge-audience-leak', detail: 'leak' },
      { rule: 'no-reply-recipient', detail: 'automated' },
    ])).toBe(false);
  });

  it('summarizes judge findings with detail', () => {
    const summary = summarizeBlockFindings([
      { rule: 'llm-judge-audience-leak', detail: 'named calendar specialist' },
    ]);
    expect(summary).toContain('llm-judge-audience-leak');
    expect(summary).toContain('calendar specialist');
  });

  it('buildContentBlockRewriteTask offers NO_REPLY alongside rewrite without duplicating voice policy', () => {
    const task = buildContentBlockRewriteTask('The calendar specialist found 4 events.', [
      { rule: 'llm-judge-audience-leak', detail: 'named internal agent' },
    ]);
    expect(task).toContain('[OUTBOUND CONTENT FILTER — REWRITE REQUIRED]');
    expect(task).toContain('The calendar specialist found 4 events.');
    expect(task).toContain('llm-judge-audience-leak');
    expect(task).toContain('named internal agent');
    expect(task).toContain('your normal audience and voice rules');
    expect(task).toContain('NO_REPLY');
    expect(task).toContain('abandons delivery');
    expect(task).toContain('Prefer NO_REPLY');
    expect(task).not.toContain('Never mention internal specialists');
  });

  it('buildContentBlockRewriteTask offers NO_REPLY for non-audience-leak blocks without preferring it', () => {
    const task = buildContentBlockRewriteTask('Thanks for the note.', [
      { rule: 'llm-judge-over-disclosure', detail: 'shared principal availability' },
    ]);
    expect(task).toContain('NO_REPLY');
    expect(task).not.toContain('Prefer NO_REPLY');
  });

  it('allows two retries after the first block', () => {
    expect(CONTENT_BLOCK_MAX_RETRIES).toBe(2);
  });

  // #2615: the rewrite turn has no tools, so the brief says it edits text only.
  it('buildContentBlockRewriteTask tells the agent this turn rewrites text only', () => {
    const task = buildContentBlockRewriteTask('Thanks for the note.', [
      { rule: 'llm-judge-over-disclosure', detail: 'shared principal availability' },
    ]);
    expect(task).toContain('no tools');
  });
});

/** A tool.result audit row as AuditLogRepo.findToolResultsForTasks returns it. */
function row(
  toolName: string,
  result: unknown,
  outcome: string | null,
  secondsAfterStart: number,
): AuditLogRow {
  return {
    id: `row-${toolName}-${secondsAfterStart}`,
    timestamp: new Date(Date.UTC(2026, 10, 14, 15, 6, secondsAfterStart)),
    eventType: 'tool.result',
    sourceLayer: 'execution',
    sourceId: 'coordinator',
    conversationId: 'email:thread-1',
    taskId: null,
    parentEventId: 'invoke-1',
    payload: { toolName, ...(result === undefined ? {} : { result }) },
    action: null,
    outcome,
    targetType: null,
    targetId: null,
    initiatorType: null,
    initiatorId: null,
    entryHash: null,
  };
}

function ok(toolName: string, data: unknown, s: number): AuditLogRow {
  return row(toolName, { success: true, data }, 'success', s);
}

function calls(actions: PriorTurnActions): PriorTurnCall[] {
  if (actions.status !== 'read') throw new Error('expected a read account');
  return actions.calls;
}

describe('priorTurnActionsFromRows (#2615)', () => {
  it('reads a turn with no tool calls as an empty account', () => {
    expect(priorTurnActionsFromRows([])).toEqual({ status: 'read', calls: [], earlierLeftOut: 0, moreBeforeLimit: false });
  });

  it('lists the calls oldest first, although the repo returns them newest first', () => {
    const list = calls(priorTurnActionsFromRows([
      ok('delegate', { agent: 'calendar', response: 'Booked it.' }, 9),
      ok('date-resolve', { formatted: 'Tuesday, November 17, 2026' }, 1),
    ]));
    expect(list.map((c) => c.tool)).toEqual(['date-resolve', 'delegate']);
    expect(list[0]!.excerpt).toContain('Tuesday, November 17, 2026');
  });

  it('marks a failed call with its error', () => {
    const [call] = calls(priorTurnActionsFromRows([row('email-send', { success: false, error: 'Not sent: recipient blocked' }, 'failure', 3)]));
    expect(call).toMatchObject({ tool: 'email-send', outcome: 'failed', excerpt: 'Not sent: recipient blocked' });
  });

  // Claimed only on positive evidence: a rewrite must not tell a recipient something was done
  // when nobody knows.
  it.each([
    ['a legacy row with no outcome and no flag', row('calendar-create-event', { data: { id: 'e1' } }, null, 1)],
    ['a row with no result at all', row('calendar-create-event', undefined, null, 1)],
    ['a row whose outcome could not be extracted', row('calendar-create-event', { success: 'maybe' }, '[EXTRACTION_FAILED]', 1)],
  ])('reads %s as outcome unknown', (_label, r) => {
    const [call] = calls(priorTurnActionsFromRows([r]));
    expect(call!.outcome).toBe('unknown');
  });

  it('trusts the result flag on a legacy row with no outcome column', () => {
    const [call] = calls(priorTurnActionsFromRows([row('date-resolve', { success: true, data: {} }, null, 1)]));
    expect(call!.outcome).toBe('succeeded');
  });

  // The specialist's answer comes first in a real delegate result, so a long one used to push
  // `sent` out of a head clip. It is lifted out of the excerpt instead.
  it('lifts a delegated call\'s specialist and sends out of a long answer', () => {
    const response = `Booked and invite sent.\n${'Notes on the week. '.repeat(200)}\nHolds released.`;
    const [call] = calls(priorTurnActionsFromRows([
      ok('delegate', { response, sent: ['calendar-create-event'], agent: 'calendar', next_step: 'x' }, 2),
    ]));
    expect(call).toMatchObject({ tool: 'delegate', agent: 'calendar', sent: ['calendar-create-event'], outcome: 'succeeded' });
    // Both ends survive the trim: the headline and the conclusion.
    expect(call!.excerpt.startsWith('Booked and invite sent.')).toBe(true);
    expect(call!.excerpt.endsWith('Holds released.')).toBe(true);
    expect(Array.from(call!.excerpt).length).toBeLessThanOrEqual(PRIOR_TURN_RESULT_MAX_CHARS);
  });

  it('keeps the calls closest to the draft when the total runs over, and counts the rest', () => {
    const big = 'y'.repeat(PRIOR_TURN_RESULT_MAX_CHARS);
    // Newest first: tool-0 is the latest call.
    const actions = priorTurnActionsFromRows(Array.from({ length: 30 }, (_, i) => ok(`tool-${i}`, { body: big }, 50 - i)));
    const list = calls(actions);
    expect(list.map((c) => c.tool)).toContain('tool-0');
    expect(list.map((c) => c.tool)).not.toContain('tool-29');
    const total = list.reduce((n, c) => n + Array.from(c.excerpt).length, 0);
    expect(total).toBeLessThanOrEqual(PRIOR_TURN_TOTAL_MAX_CHARS);
    expect(actions).toMatchObject({ earlierLeftOut: 30 - list.length, moreBeforeLimit: false });
  });

  // The dispatcher reads one more than the limit: a full read means older calls exist.
  it('says more calls exist when the read came back over the limit', () => {
    const rows = Array.from({ length: PRIOR_TURN_RESULTS_LIMIT + 1 }, (_, i) => ok(`tool-${i}`, {}, 100 - i));
    const actions = priorTurnActionsFromRows(rows);
    expect(actions).toMatchObject({ status: 'read', moreBeforeLimit: true });
    expect(calls(actions).map((c) => c.tool)).not.toContain(`tool-${PRIOR_TURN_RESULTS_LIMIT}`);
  });

  it('redacts credential-shaped values, in prose answers as in JSON results', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const list = calls(priorTurnActionsFromRows([
      ok('vault-read', { value: key }, 1),
      ok('delegate', { agent: 'research', response: `The key is ${key}.` }, 2),
    ]));
    for (const c of list) {
      expect(c.excerpt).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
      expect(c.excerpt).toContain('[REDACTED]');
    }
  });
});

describe('clipMiddleCodePoints (#2615)', () => {
  it('returns short text unchanged', () => {
    expect(clipMiddleCodePoints('short', 100)).toBe('short');
  });

  // A lone surrogate in the task payload fails its jsonb audit write, losing the reply.
  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(2_000);
    const clipped = clipMiddleCodePoints(text, 101);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(clipped).length).toBeLessThanOrEqual(101);
  });
});
