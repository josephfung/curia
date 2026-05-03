// approval-trigger.test.ts — unit tests for ApprovalTriggerService.
//
// Tests are structured in two groups:
//   1. Pure functions (shortRefPrefix, buildDescription) — no mocks needed
//   2. request() method (Task 4) — mocks ActionLogRepo and OutboundGateway

import { describe, it, expect } from 'vitest';
import { shortRefPrefix, buildDescription } from './approval-trigger.js';

describe('shortRefPrefix', () => {
  it('maps calendar-* skills to "cal"', () => {
    expect(shortRefPrefix('calendar-create-event')).toBe('cal');
    expect(shortRefPrefix('calendar-update-event')).toBe('cal');
  });

  it('maps email-* skills to "email"', () => {
    expect(shortRefPrefix('email-reply')).toBe('email');
    expect(shortRefPrefix('email-draft-save')).toBe('email');
  });

  it('maps signal-* skills to "signal"', () => {
    expect(shortRefPrefix('signal-send')).toBe('signal');
  });

  it('maps store-fact to "mem"', () => {
    expect(shortRefPrefix('store-fact')).toBe('mem');
  });

  it('maps *-memory-* skills to "mem"', () => {
    expect(shortRefPrefix('entity-memory-store')).toBe('mem');
  });

  it('maps *-contact* skills to "contact"', () => {
    expect(shortRefPrefix('update-contact')).toBe('contact');
    expect(shortRefPrefix('contact-merge')).toBe('contact');
  });

  it('maps schedule-* skills to "sched"', () => {
    expect(shortRefPrefix('schedule-job')).toBe('sched');
  });

  it('falls back to first word of skill name, truncated to 6 chars', () => {
    expect(shortRefPrefix('something-unusual')).toBe('someth');
    expect(shortRefPrefix('web-search')).toBe('web');
  });
});

describe('buildDescription', () => {
  it('formats calendar-create-event with title', () => {
    const desc = buildDescription('calendar-create-event', { title: 'Lunch with Dana', start: '2026-05-06T12:00:00-04:00' });
    expect(desc).toContain('Create calendar event');
    expect(desc).toContain('Lunch with Dana');
  });

  it('formats email-reply with to and subject', () => {
    const desc = buildDescription('email-reply', { to: 'dana@example.com', subject: 'Re: Budget' });
    expect(desc).toContain('Send email reply');
    expect(desc).toContain('dana@example.com');
    expect(desc).toContain('Re: Budget');
  });

  it('formats store-fact with label', () => {
    const desc = buildDescription('store-fact', { label: 'Dana prefers mornings' });
    expect(desc).toContain('Store fact');
    expect(desc).toContain('Dana prefers mornings');
  });

  it('falls back to "Run {skill_name}" for unknown skills', () => {
    const desc = buildDescription('some-unknown-skill', {});
    expect(desc).toBe('Run some-unknown-skill');
  });

  it('truncates individual values to 80 chars', () => {
    const longTitle = 'A'.repeat(100);
    const desc = buildDescription('calendar-create-event', { title: longTitle });
    // The value portion should be truncated, not the full description
    expect(desc.length).toBeLessThanOrEqual(200);
    expect(desc).not.toContain(longTitle);
  });

  it('truncates the full description to 200 chars', () => {
    const desc = buildDescription('email-reply', {
      to: 'very-long-email-address-that-goes-on-forever@example.com',
      subject: 'Re: A very long subject line that keeps going and going and going',
      body: 'This body is also very long and should not appear in the description',
    });
    expect(desc.length).toBeLessThanOrEqual(200);
  });
});
