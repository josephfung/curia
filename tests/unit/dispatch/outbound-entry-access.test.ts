// Which inbound senders may be shown, and recorded on, the entries sent to them (#2261).
import { describe, expect, it } from 'vitest';
import { inboundSenderAuthenticated } from '../../../src/dispatch/outbound-entry-access.js';

describe('inboundSenderAuthenticated', () => {
  it('trusts protocol-authenticated channels', () => {
    expect(inboundSenderAuthenticated('signal', undefined)).toBe(true);
    expect(inboundSenderAuthenticated('slack', undefined)).toBe(true);
  });

  it('trusts email only when SPF, DKIM and DMARC passed', () => {
    expect(inboundSenderAuthenticated('email', { senderVerified: true })).toBe(true);
    expect(inboundSenderAuthenticated('email', { senderVerified: false })).toBe(false);
    expect(inboundSenderAuthenticated('email', { senderVerified: 'true' })).toBe(false);
    expect(inboundSenderAuthenticated('email', undefined)).toBe(false);
  });

  it('refuses spoofable and unknown channels', () => {
    expect(inboundSenderAuthenticated('sms', { senderVerified: true })).toBe(false);
    expect(inboundSenderAuthenticated('voice', undefined)).toBe(false);
    expect(inboundSenderAuthenticated('carrier-pigeon', undefined)).toBe(false);
  });
});
