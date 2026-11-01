import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  countJobs,
  dayKeysEnding,
  hiccupsOver,
  localDayKey,
  localMidnight,
  approvalNeedsDraft,
  approvalReviewSummary,
  mailboxDraftRef,
  shapeHistogram,
  shapeHistogramFromCounts,
  type ProjectedJob,
} from '../../../src/dashboard/briefing.js';

const TORONTO = 'America/Toronto';

describe('local day boundaries', () => {
  it('keeps 14 consecutive dates across the autumn fallback', () => {
    // 2026-11-01 is the first Sunday in November: clocks fall back at 02:00.
    const now = new Date('2026-11-04T15:00:00.000Z');
    const today = localDayKey(now, TORONTO);
    expect(today).toBe('2026-11-04');
    const keys = dayKeysEnding(today, 14);
    expect(keys).toHaveLength(14);
    expect(new Set(keys).size).toBe(14);
    expect(keys[0]).toBe('2026-10-22');
    expect(keys[13]).toBe('2026-11-04');
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]).toBe(addCalendarDays(keys[i - 1]!, 1));
    }
  });

  it('maps both sides of the fallback hour onto the same local date', () => {
    // 01:30 EDT and, an hour later, 01:30 EST are both 1 November.
    expect(localDayKey(new Date('2026-11-01T05:30:00.000Z'), TORONTO)).toBe('2026-11-01');
    expect(localDayKey(new Date('2026-11-01T06:30:00.000Z'), TORONTO)).toBe('2026-11-01');
    expect(localDayKey(new Date('2026-11-01T03:59:00.000Z'), TORONTO)).toBe('2026-10-31');
  });

  it('does not skip a date on the spring forward', () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT.
    const now = new Date('2026-03-10T15:00:00.000Z');
    const keys = dayKeysEnding(localDayKey(now, TORONTO), 14);
    expect(keys).toContain('2026-03-08');
    expect(new Set(keys).size).toBe(14);
    expect(localDayKey(new Date('2026-03-08T06:30:00.000Z'), TORONTO)).toBe('2026-03-08');
    expect(localDayKey(new Date('2026-03-08T07:30:00.000Z'), TORONTO)).toBe('2026-03-08');
  });

  it('local midnight is the first instant of that calendar day', () => {
    const start = localMidnight('2026-11-01', TORONTO);
    expect(localDayKey(start, TORONTO)).toBe('2026-11-01');
    expect(localDayKey(new Date(start.getTime() - 1), TORONTO)).toBe('2026-10-31');

    const spring = localMidnight('2026-03-08', TORONTO);
    expect(localDayKey(spring, TORONTO)).toBe('2026-03-08');
    expect(localDayKey(new Date(spring.getTime() - 1), TORONTO)).toBe('2026-03-07');
  });
});

describe('shapeHistogram', () => {
  const now = new Date('2026-10-28T15:00:00.000Z'); // 11:00 in Toronto

  function job(day: string, hourUtc: number, actor: string, outcome: ProjectedJob['outcome']): ProjectedJob {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return { ts: new Date(Date.UTC(y, m - 1, d, hourUtc)).toISOString(), actor, outcome };
  }

  it('buckets by the principal timezone and agrees the hiccup tile with the bars', () => {
    const jobs = [
      job('2026-10-28', 14, 'ceo-inbox', 'success'),
      job('2026-10-28', 13, 'calendar', 'failed'),
      job('2026-10-27', 16, 'ceo-inbox', 'partial'),
      // 03:30Z on the 28th is still the 27th in Toronto (23:30 EDT).
      job('2026-10-28', 3, 'research', 'success'),
      job('2026-10-14', 15, 'ceo-inbox', 'failed'), // outside the 14 days ending the 28th
    ];
    const model = shapeHistogram(jobs, now, TORONTO);
    expect(model.days).toHaveLength(14);
    expect(model.days[13]).toMatchObject({ key: '2026-10-28', today: true, label: 'Today', total: 2, hiccups: 1 });
    const yesterday = model.days.find((day) => day.key === '2026-10-27');
    expect(yesterday).toMatchObject({ total: 2, hiccups: 1 });
    expect(yesterday?.byAgent['research']).toBe(1);
    expect(model.days[0]?.key).toBe('2026-10-15');
    expect(model.days[0]).toMatchObject({ key: '2026-10-15', total: 0 });

    const last7 = new Set(model.days.slice(-7).map((day) => day.key));
    expect(hiccupsOver(model, 7)).toBe(
      model.days.slice(-7).reduce((sum, day) => sum + day.hiccups, 0),
    );
    expect(countJobs(jobs, last7, TORONTO, new Set(['success', 'partial']))).toBe(
      model.days.slice(-7).reduce((sum, day) => sum + day.byOutcome.success + day.byOutcome.partial, 0),
    );
  });

  it('folds agents past the limit into other', () => {
    const jobs: ProjectedJob[] = [];
    for (let i = 0; i < 8; i++) {
      jobs.push({ ts: now.toISOString(), actor: `agent-${i}`, outcome: 'success' });
      if (i < 2) jobs.push({ ts: now.toISOString(), actor: `agent-${i}`, outcome: 'success' });
    }
    const model = shapeHistogram(jobs, now, TORONTO);
    expect(model.agents).toHaveLength(7);
    expect(model.agents[6]).toBe('other');
    expect(model.agents.slice(0, 2)).toEqual(['agent-0', 'agent-1']);
    const today = model.days[13]!;
    expect(today.byAgent['other']).toBe(2);
  });

  it('marks weekend labels and a dashed-today flag without putting today on a weekend key', () => {
    const model = shapeHistogram([], now, TORONTO);
    const saturday = model.days.find((day) => day.key === '2026-10-24');
    const sunday = model.days.find((day) => day.key === '2026-10-25');
    expect(saturday).toMatchObject({ label: 'Sa', weekend: true, today: false });
    expect(sunday).toMatchObject({ label: 'Su', weekend: true });
    expect(model.days.filter((day) => day.today).map((day) => day.key)).toEqual(['2026-10-28']);
  });
});

describe('approval review', () => {
  it('includes the message the approval would send', () => {
    const summary = approvalReviewSummary({
      description: 'Reply to vendor',
      toolName: 'email-send',
      payload: { to: 'ada@example.com', subject: 'Renewal', body: 'Please find the terms attached.' },
    });
    expect(summary).toContain('Reply to vendor');
    expect(summary).toContain('To: ada@example.com');
    expect(summary).toContain('Subject: Renewal');
    expect(summary).toContain('Body: Please find the terms attached.');
  });

  it('asks for a mailbox read when a send-draft stored only an id', () => {
    expect(approvalNeedsDraft('send-draft', { draft_id: 'd1' })).toBe(true);
    expect(approvalNeedsDraft('send-draft', { draft_id: 'd1', subject: 'Renewal', body: 'Hi' })).toBe(true);
    expect(approvalNeedsDraft('send-draft', { draft_id: 'd1', to: 'ada@example.com' })).toBe(true);
    expect(approvalNeedsDraft('send-draft', { draft_id: 'd1', to: '  ', body: 'Hi' })).toBe(true);
    expect(approvalNeedsDraft('send-draft', { draft_id: 'd1', to: 'ada@example.com', body: 'Hi' })).toBe(false);
    expect(approvalNeedsDraft('email-send', { draft_id: 'd1' })).toBe(false);
  });
});

describe('shapeHistogramFromCounts', () => {
  it('adds the count instead of one row, and keeps hiccups equal to the bars', () => {
    const now = new Date('2026-10-28T15:00:00.000Z');
    const model = shapeHistogramFromCounts(
      [{ day: '2026-10-28', actor: 'ceo-inbox', outcome: 'failed', n: 3 }],
      now,
      TORONTO,
    );
    const today = model.days[13]!;
    expect(today).toMatchObject({ total: 3, hiccups: 3 });
    expect(today.byOutcome.failed).toBe(3);
    expect(model.days.slice(-7).reduce((sum, day) => sum + day.hiccups, 0)).toBe(3);
  });
});

describe('mailboxDraftRef', () => {
  it('reads a send-draft payload and ignores other tools', () => {
    expect(mailboxDraftRef('send-draft', { draft_id: 'd1', account: 'ops' })).toEqual({ draftId: 'd1', account: 'ops' });
    expect(mailboxDraftRef('email-send', { draft_id: 'd1' })).toBeNull();
    expect(mailboxDraftRef('send-draft', { subject: 'hi' })).toBeNull();
  });
});

