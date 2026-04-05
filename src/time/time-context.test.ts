import { describe, it, expect } from 'vitest';
import { formatCurrentDate, formatTimeContextBlock } from './time-context.js';

describe('formatCurrentDate', () => {
  it('formats a known date in Toronto (EDT, UTC-4)', () => {
    // 2026-04-06T08:00:00Z = 04:00 EDT — still April 6 in Toronto
    const now = new Date('2026-04-06T08:00:00Z');
    expect(formatCurrentDate(now, 'America/Toronto')).toBe('Monday, April 6, 2026');
  });

  it('handles DST boundary — midnight UTC is previous day in Toronto (EST, UTC-5)', () => {
    // 2026-01-06T00:30:00Z = Jan 5 at 7:30pm EST — previous calendar day
    const now = new Date('2026-01-06T00:30:00Z');
    expect(formatCurrentDate(now, 'America/Toronto')).toBe('Monday, January 5, 2026');
  });

  it('returns the correct day when running near midnight server time', () => {
    // 2026-04-07T03:59:00Z = Apr 6 at 11:59pm EDT — still April 6 in Toronto
    const now = new Date('2026-04-07T03:59:00Z');
    expect(formatCurrentDate(now, 'America/Toronto')).toBe('Monday, April 6, 2026');
  });
});

describe('formatTimeContextBlock', () => {
  it('contains all expected section labels', () => {
    const now = new Date('2026-04-06T12:00:00Z');
    const block = formatTimeContextBlock('America/Toronto', now);
    expect(block).toContain('## Current Date & Time');
    expect(block).toContain('Date:');
    expect(block).toContain('Time:');
    expect(block).toContain('Timezone: America/Toronto');
  });

  it('shows EDT offset in April (UTC-04:00)', () => {
    const now = new Date('2026-04-06T12:00:00Z');
    const block = formatTimeContextBlock('America/Toronto', now);
    expect(block).toContain('UTC-04:00');
  });

  it('shows EST offset in January (UTC-05:00)', () => {
    const now = new Date('2026-01-06T12:00:00Z');
    const block = formatTimeContextBlock('America/Toronto', now);
    expect(block).toContain('UTC-05:00');
  });

  it('handles sub-hour timezone (Asia/Kolkata = UTC+05:30)', () => {
    const now = new Date('2026-04-06T12:00:00Z');
    const block = formatTimeContextBlock('Asia/Kolkata', now);
    expect(block).toContain('UTC+05:30');
    expect(block).not.toContain('UTC+5.5');
  });
});
