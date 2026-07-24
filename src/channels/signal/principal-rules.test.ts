import { describe, it, expect } from 'vitest';
import { signalPrincipalRules } from './principal-rules.js';
import type { SignalOutboundRequest } from './outbound-request.js';

describe('signalPrincipalRules.extractRecipients', () => {
  it('projects a 1:1 recipient as principal-eligible', () => {
    const request: SignalOutboundRequest = {
      channel: 'signal',
      recipient: '+15551234567',
      message: 'hi',
    };
    expect(signalPrincipalRules.extractRecipients(request)).toEqual([
      { identifier: '+15551234567', principalEligible: true },
    ]);
  });

  it('marks groupId as never-principal', () => {
    const request: SignalOutboundRequest = {
      channel: 'signal',
      groupId: 'group-base64==',
      message: 'group ping',
    };
    expect(signalPrincipalRules.extractRecipients(request)).toEqual([
      { identifier: 'group-base64==', principalEligible: false },
    ]);
  });

  it('prefers recipient over groupId when both are present', () => {
    const request: SignalOutboundRequest = {
      channel: 'signal',
      recipient: '+15551234567',
      groupId: 'group-base64==',
      message: 'hi',
    };
    expect(signalPrincipalRules.extractRecipients(request)).toEqual([
      { identifier: '+15551234567', principalEligible: true },
    ]);
  });

  it('returns null for a non-signal request shape (fail closed)', () => {
    expect(signalPrincipalRules.extractRecipients({
      channel: 'email',
      to: 'ceo@example.com',
      body: 'hi',
    })).toBeNull();
  });
});
