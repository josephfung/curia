import { describe, it, expect } from 'vitest';
import { emailPrincipalRules } from './principal-rules.js';
import type { EmailSendRequest } from './outbound-request.js';

describe('emailPrincipalRules.extractRecipients', () => {
  it('projects to + cc as principal-eligible', () => {
    const request: EmailSendRequest = {
      channel: 'email',
      to: 'ceo@example.com',
      body: 'hi',
      cc: ['other@example.com', ''],
    };
    expect(emailPrincipalRules.extractRecipients(request)).toEqual([
      { identifier: 'ceo@example.com', principalEligible: true },
      { identifier: 'other@example.com', principalEligible: true },
    ]);
  });

  it('returns null for a non-email request shape (fail closed)', () => {
    expect(emailPrincipalRules.extractRecipients({
      channel: 'signal',
      recipient: '+15551234567',
      message: 'hi',
    })).toBeNull();
  });
});
