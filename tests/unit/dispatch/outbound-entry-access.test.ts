// Which inbound senders may be shown, and recorded on, the entries sent to them (#2261).
// Every test here fails closed: missing adapter metadata means no.
import { describe, expect, it } from 'vitest';
import { inboundIsOneToOne, inboundSenderAuthenticated, outsiderOriginatorContactId } from '../../../src/dispatch/outbound-entry-access.js';

describe('inboundSenderAuthenticated', () => {
  it('trusts protocol-authenticated channels', () => {
    expect(inboundSenderAuthenticated('signal', undefined)).toBe(true);
    expect(inboundSenderAuthenticated('slack', undefined)).toBe(true);
  });

  // The console's chat route admits only a logged-in principal session or the principal-only
  // bootstrap secret, so the session proves who wrote the message (maintainer, 2026-11-16).
  it('trusts the web console', () => {
    expect(inboundSenderAuthenticated('web', undefined)).toBe(true);
  });

  // Only the principal has shell access to the host the CLI runs on (maintainer, 2026-11-17).
  it('trusts the local CLI', () => {
    expect(inboundSenderAuthenticated('cli', undefined)).toBe(true);
  });

  it('trusts email only when SPF, DKIM and DMARC passed', () => {
    expect(inboundSenderAuthenticated('email', { senderVerified: true })).toBe(true);
    expect(inboundSenderAuthenticated('email', { senderVerified: false })).toBe(false);
    expect(inboundSenderAuthenticated('email', { senderVerified: 'true' })).toBe(false);
    expect(inboundSenderAuthenticated('email', undefined)).toBe(false);
  });

  it('refuses spoofable and unknown channels', () => {
    expect(inboundSenderAuthenticated('sms', { senderVerified: true })).toBe(false);
    // Voice is decided per session in voice/caller-context.ts, never from the channel id.
    expect(inboundSenderAuthenticated('voice', undefined)).toBe(false);
    // The smoke-test channel is not a login either (the smoke suite was removed).
    expect(inboundSenderAuthenticated('smoke-test', undefined)).toBe(false);
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

describe('outsiderOriginatorContactId', () => {
  const principal = (authenticated?: boolean) => ({
    originator: {
      contactId: 'p1', systemRole: 'principal', channel: 'sms', initiatedAt: '2026-11-17T00:00:00Z',
      ...(authenticated !== undefined ? { authenticated } : {}),
    },
  });

  it('lets an authenticated principal turn act on any entry', () => {
    expect(outsiderOriginatorContactId(principal(true))).toBeNull();
  });

  // GHSA-p49r-jqh2-v668: a forged principal sees only the entries sent to the principal.
  it.each([false, undefined])('limits a principal turn with authenticated=%s to the principal\'s own entries', (authenticated) => {
    expect(outsiderOriginatorContactId(principal(authenticated))).toBe('p1');
  });
});
