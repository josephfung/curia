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
  it('skips medium-risk reads', () => {
    expect(isSampledTool('file-parse', 'medium')).toBe(false);
  });
});
