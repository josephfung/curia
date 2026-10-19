import { describe, it, expect } from 'vitest';
import { isSampledTool, TRIAGE_SKILLS } from '../../../src/autonomy/sample-pool.js';

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
