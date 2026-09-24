import { describe, it, expect } from 'vitest';
import { smsPrincipalRules } from '../../../../src/channels/sms/principal-rules.js';
import { isSmsOutboundRequest } from '../../../../src/channels/sms/outbound-request.js';

describe('sms principal-rules', () => {
  it('extracts peer E.164 as principal-eligible', () => {
    const recipients = smsPrincipalRules.extractRecipients({
      channel: 'sms',
      recipient: '+14155552671',
      message: 'hi',
    });
    expect(recipients).toEqual([
      { identifier: '+14155552671', principalEligible: true },
    ]);
  });

  it('returns null for foreign request shapes', () => {
    expect(smsPrincipalRules.extractRecipients({ channel: 'signal', message: 'x' })).toBeNull();
    expect(smsPrincipalRules.extractRecipients(null)).toBeNull();
  });

  it('Gate C carve-out parses recipient and fails closed on unmodeled keys', () => {
    const parse = smsPrincipalRules.carveoutSkill!.parseRecipients;
    expect(parse({ recipient: '+14155552671', message: 'hi' })).toEqual(['+14155552671']);
    expect(parse({ recipient: '+14155552671', to: 'other@example.com' })).toBeNull();
    expect(parse({ message: 'hi' })).toBeNull();
  });

  it('type-guards SmsOutboundRequest', () => {
    expect(isSmsOutboundRequest({ channel: 'sms', recipient: '+1', message: 'x' })).toBe(true);
    expect(isSmsOutboundRequest({ channel: 'sms', message: 'x' })).toBe(false);
  });
});
