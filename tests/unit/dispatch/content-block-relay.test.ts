import { describe, it, expect } from 'vitest';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
import {
  CONTENT_BLOCK_MAX_RETRIES,
  PRIOR_TURN_ACTIONS_HEADING,
  PRIOR_TURN_RESULT_MAX_CHARS,
  PRIOR_TURN_TOTAL_MAX_CHARS,
  buildContentBlockRewriteTask,
  isContentFilterRewriteable,
  renderPriorTurnActions,
  summarizeBlockFindings,
} from '../../../src/dispatch/content-block-relay.js';

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

  it('buildContentBlockRewriteTask leaves the previous-turn section out when there is nothing to show', () => {
    const task = buildContentBlockRewriteTask('Thanks for the note.', [
      { rule: 'llm-judge-over-disclosure', detail: 'shared principal availability' },
    ]);
    expect(task).not.toContain(PRIOR_TURN_ACTIONS_HEADING);
  });

  // #2615: a rewrite that cannot see the booking its own turn made re-plans and contradicts it.
  it('buildContentBlockRewriteTask shows what the previous turn already did, ahead of the blocked draft', () => {
    const actions = renderPriorTurnActions([
      toolResultRow('delegate', true, { sent: ['calendar-create-event'], response: 'Booked Tue 2:00 PM and sent the invite.' }, 2),
    ]);
    const task = buildContentBlockRewriteTask('Invite is sent, with a Google Meet link.', [
      { rule: 'unresolved-identity', detail: 'Unresolved identity: "Google Meet"' },
    ], actions ?? undefined);
    expect(task).toContain(PRIOR_TURN_ACTIONS_HEADING);
    expect(task).toContain('Booked Tue 2:00 PM and sent the invite.');
    expect(task.indexOf(PRIOR_TURN_ACTIONS_HEADING)).toBeLessThan(task.indexOf('Blocked draft:'));
  });
});

/** A tool.result audit row as AuditLogRepo.findToolResultsForTasks returns it. */
function toolResultRow(
  toolName: string,
  success: boolean,
  dataOrError: unknown,
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
    payload: {
      toolName,
      result: success ? { success: true, data: dataOrError } : { success: false, error: dataOrError },
    },
    action: null,
    outcome: success ? 'success' : 'failure',
    targetType: null,
    targetId: null,
    initiatorType: null,
    initiatorId: null,
    entryHash: null,
  };
}

describe('renderPriorTurnActions (#2615)', () => {
  it('returns null when the previous turn called no tools', () => {
    expect(renderPriorTurnActions([])).toBeNull();
  });

  it('lists the calls oldest first, although the repo returns them newest first', () => {
    // findToolResultsForTasks orders newest first.
    const rendered = renderPriorTurnActions([
      toolResultRow('delegate', true, { response: 'Booked it.' }, 9),
      toolResultRow('date-resolve', true, { formatted: 'Tuesday, November 17, 2026' }, 1),
    ])!;
    expect(rendered.indexOf('date-resolve')).toBeLessThan(rendered.indexOf('delegate'));
    expect(rendered).toContain('Tuesday, November 17, 2026');
    expect(rendered).toContain('Booked it.');
  });

  it('marks a call that failed, so the rewrite does not treat it as done', () => {
    const rendered = renderPriorTurnActions([
      toolResultRow('email-send', false, 'Not sent: recipient blocked', 3),
    ])!;
    expect(rendered).toMatch(/email-send.*failed/);
    expect(rendered).toContain('Not sent: recipient blocked');
  });

  it('clips a long result', () => {
    const long = 'x'.repeat(PRIOR_TURN_RESULT_MAX_CHARS * 3);
    const rendered = renderPriorTurnActions([toolResultRow('email-get-thread', true, { body: long }, 1)])!;
    expect(rendered.length).toBeLessThan(PRIOR_TURN_RESULT_MAX_CHARS + 200);
  });

  it('keeps the calls closest to the draft when the total would run over, and says how many were left out', () => {
    const big = 'y'.repeat(PRIOR_TURN_RESULT_MAX_CHARS);
    // Newest first, as the repo returns them: second 50 is the latest call.
    const rows = Array.from({ length: 30 }, (_, i) => toolResultRow(`tool-${i}`, true, { body: big }, 50 - i));
    const rendered = renderPriorTurnActions(rows)!;
    expect(rendered.length).toBeLessThanOrEqual(PRIOR_TURN_TOTAL_MAX_CHARS + 200);
    expect(rendered).toContain('tool-0');
    expect(rendered).not.toContain('tool-29');
    expect(rendered).toMatch(/\d+ earlier calls? left out/);
  });

  // The brief is stored in working memory and audit_log; a credential a tool returned
  // must not be copied there (same redaction as the send review's evidence).
  it('redacts credential-shaped values', () => {
    const rendered = renderPriorTurnActions([
      toolResultRow('vault-read', true, { value: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD' }, 1),
    ])!;
    expect(rendered).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(rendered).toContain('[REDACTED]');
  });
});
