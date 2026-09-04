import { describe, it, expect } from 'vitest';
import {
  CONTENT_BLOCK_MAX_RETRIES,
  buildContentBlockRewriteTask,
  isContentFilterRewriteable,
  summarizeBlockFindings,
} from '../../../src/dispatch/content-block-relay.js';

describe('content-block-relay', () => {
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
});
