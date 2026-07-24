import { describe, it, expect } from 'vitest';
import { slackPrincipalRules } from './principal-rules.js';
import type { SlackOutboundRequest } from './outbound-request.js';

describe('slackPrincipalRules.extractRecipients', () => {
  it('projects slackUserId as principal-eligible', () => {
    const request: SlackOutboundRequest = {
      channel: 'slack',
      slackChannelId: 'D123',
      slackUserId: 'U_CEO',
      message: 'hi',
    };
    expect(slackPrincipalRules.extractRecipients(request)).toEqual([
      { identifier: 'U_CEO', principalEligible: true },
    ]);
  });

  it('marks slackChannelId (D…/C…) as never-principal when no user id', () => {
    const dm: SlackOutboundRequest = {
      channel: 'slack',
      slackChannelId: 'D123',
      message: 'hi',
    };
    expect(slackPrincipalRules.extractRecipients(dm)).toEqual([
      { identifier: 'D123', principalEligible: false },
    ]);

    const channel: SlackOutboundRequest = {
      channel: 'slack',
      slackChannelId: 'C456',
      message: 'hi',
    };
    expect(slackPrincipalRules.extractRecipients(channel)).toEqual([
      { identifier: 'C456', principalEligible: false },
    ]);
  });

  it('never trusts the conversation id when slackUserId is set', () => {
    const request: SlackOutboundRequest = {
      channel: 'slack',
      slackChannelId: 'D123',
      slackUserId: 'U_CEO',
      message: 'hi',
    };
    const projected = slackPrincipalRules.extractRecipients(request)!;
    expect(projected.some((r) => r.identifier === 'D123')).toBe(false);
    expect(projected).toEqual([{ identifier: 'U_CEO', principalEligible: true }]);
  });

  it('returns null for a non-slack request shape (fail closed)', () => {
    expect(slackPrincipalRules.extractRecipients({
      channel: 'email',
      to: 'ceo@example.com',
      body: 'hi',
    })).toBeNull();
  });
});
