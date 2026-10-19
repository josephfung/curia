import { describe, it, expect } from 'vitest';
import { formatEmailSummary, isSampledTool, sampleWeight, selectSamples, TRIAGE_SKILLS } from '../../../src/autonomy/sample-pool.js';

describe('isSampledTool', () => {
  it('leaves sends to the gateway, which records them itself', () => {
    for (const t of ['email-send', 'email-reply', 'send-draft', 'signal-send', 'sms-send', 'slack-send', 'dispatcher-relay']) {
      expect(isSampledTool(t, 'medium')).toBe(false);
    }
  });
  it('samples triage at low risk', () => {
    for (const t of TRIAGE_SKILLS) expect(isSampledTool(t, 'low')).toBe(true);
  });
  it('samples medium risk and up, by label or number', () => {
    expect(isSampledTool('calendar-create-event', 'high')).toBe(true);
    expect(isSampledTool('calendar-respond-to-invite', 'medium')).toBe(true);
    expect(isSampledTool('some-tool', 75)).toBe(true);
  });
  it('skips low and none risk outside triage', () => {
    expect(isSampledTool('contact-update', 'low')).toBe(false);
    expect(isSampledTool('activity-log', 'none')).toBe(false);
    expect(isSampledTool('some-tool', 65)).toBe(false);
  });
  it('leaves ceo-inbox-update-folders out: triage pairs it with an archive of the same message', () => {
    // One triage decision must be one pool row, not two (#2159 Phase 3 review).
    expect(TRIAGE_SKILLS.has('ceo-inbox-update-folders')).toBe(false);
    expect(isSampledTool('ceo-inbox-update-folders', 'low')).toBe(false);
  });
  it('skips medium-risk reads', () => {
    expect(isSampledTool('file-parse', 'medium')).toBe(false);
  });
  it('skips web-browser, which floods the pool, and voice-learn, which only proposes', () => {
    expect(isSampledTool('web-browser', 'medium')).toBe(false);
    expect(isSampledTool('voice-learn', 'medium')).toBe(false);
  });
});

describe('sampleWeight', () => {
  it('weighs speaking for the principal, first contact, a judge intervention, a proceeded gate and triage high', () => {
    for (const s of [{ speaksAsPrincipal: true }, { firstContact: true }, { review: 'trimmed' as const }, { review: 'bounced' as const }, { review: 'unreviewed' as const }, { gateProceeded: true }, { triage: true }]) {
      expect(sampleWeight(s)).toBe(3);
    }
  });
  it('weighs routine actions low but never zero', () => {
    expect(sampleWeight({})).toBe(1);
  });
});

describe('selectSamples', () => {
  it('returns at most the cap, without repeats', () => {
    const picked = selectSamples([1, 2, 3, 4, 5], () => 1, 3, () => 0.5);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
  });
  it('returns everything when there are fewer candidates than the cap', () => {
    expect(selectSamples(['a'], () => 1, 3, Math.random)).toEqual(['a']);
  });
  it('favours heavy candidates', () => {
    let heavy = 0;
    let seed = 1;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 2000; i++) {
      if (selectSamples(['light', 'heavy'], (c) => (c === 'heavy' ? 3 : 1), 1, rand)[0] === 'heavy') heavy++;
    }
    expect(heavy / 2000).toBeGreaterThan(0.7);
    expect(heavy / 2000).toBeLessThan(0.8);
  });
});

describe('formatEmailSummary', () => {
  it('adds the subject and sender to the base summary', () => {
    expect(formatEmailSummary('Archive an email', 'Statement ready', 'Billing (billing@example.com)'))
      .toBe('Archive an email: "Statement ready" from Billing (billing@example.com)');
  });
  it('drops a missing part', () => {
    expect(formatEmailSummary('Archive an email', 'Statement ready')).toBe('Archive an email: "Statement ready"');
    expect(formatEmailSummary('Archive an email', undefined, 'sam@example.com')).toBe('Archive an email: from sam@example.com');
  });
  it('returns the base unchanged when there is nothing to add', () => {
    expect(formatEmailSummary('Archive an email')).toBe('Archive an email');
    expect(formatEmailSummary('Archive an email', '  ', '')).toBe('Archive an email');
  });
  it('collapses line breaks and caps the length', () => {
    const out = formatEmailSummary('Archive an email', `Re:\n${'very long subject '.repeat(20)}`, 'sam@example.com');
    expect(out.startsWith('Archive an email: "Re: very long subject')).toBe(true);
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });
});
