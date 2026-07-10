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

  it('summarizes judge findings with detail', () => {
    const summary = summarizeBlockFindings([
      { rule: 'llm-judge-audience-leak', detail: 'named calendar specialist' },
    ]);
    expect(summary).toContain('llm-judge-audience-leak');
    expect(summary).toContain('calendar specialist');
  });

  it('buildContentBlockRewriteTask includes blocked body and first-person guidance', () => {
    const task = buildContentBlockRewriteTask('The calendar specialist found 4 events.', [
      { rule: 'llm-judge-audience-leak', detail: 'named internal agent' },
    ]);
    expect(task).toContain('[OUTBOUND CONTENT FILTER — REWRITE REQUIRED]');
    expect(task).toContain('The calendar specialist found 4 events.');
    expect(task).toContain('first person');
    expect(task).toContain('llm-judge-audience-leak');
  });

  it('allows two retries after the first block', () => {
    expect(CONTENT_BLOCK_MAX_RETRIES).toBe(2);
  });
});
