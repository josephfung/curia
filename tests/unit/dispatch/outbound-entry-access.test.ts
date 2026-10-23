// Which inbound senders may be shown, and recorded on, the entries sent to them (#2261).
// Every test here fails closed: missing adapter metadata means no.
import { describe, expect, it } from 'vitest';
import { inboundIsOneToOne, inboundSenderAuthenticated } from '../../../src/dispatch/outbound-entry-access.js';

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

describe('inboundIsOneToOne', () => {
  it('Signal: only a non-group message', () => {
    expect(inboundIsOneToOne('signal', { isGroup: false })).toBe(true);
    expect(inboundIsOneToOne('signal', { isGroup: true, groupId: 'Z3JvdXA=' })).toBe(false);
    expect(inboundIsOneToOne('signal', { isGroup: false, groupId: 'Z3JvdXA=' })).toBe(false);
    expect(inboundIsOneToOne('signal', undefined)).toBe(false);
  });

  it('Slack: only a DM', () => {
    expect(inboundIsOneToOne('slack', { isDm: true })).toBe(true);
    expect(inboundIsOneToOne('slack', { isDm: false })).toBe(false);
    expect(inboundIsOneToOne('slack', {})).toBe(false);
  });

  it('email: only when Curia is on To and nobody else is on To or CC', () => {
    expect(inboundIsOneToOne('email', { curiaRole: 'to', otherRecipientCount: 0 })).toBe(true);
    expect(inboundIsOneToOne('email', { curiaRole: 'to', otherRecipientCount: 1 })).toBe(false);
    expect(inboundIsOneToOne('email', { curiaRole: 'cc', otherRecipientCount: 0 })).toBe(false);
    expect(inboundIsOneToOne('email', { curiaRole: 'to' })).toBe(false);
    expect(inboundIsOneToOne('email', { curiaRole: 'to', otherRecipientCount: '0' })).toBe(false);
  });

  it('refuses every other channel', () => {
    expect(inboundIsOneToOne('sms', { isGroup: false })).toBe(false);
    expect(inboundIsOneToOne('http', { isDm: true })).toBe(false);
  });
});
