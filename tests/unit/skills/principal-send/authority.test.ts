import { describe, it, expect } from 'vitest';
import { isPrincipalDirectedMailboxSend } from '../../../../src/skills/principal-send/authority.js';

function principalMeta(channel: string, authenticated?: boolean): Record<string, unknown> {
  return {
    originator: {
      contactId: 'ceo-contact-id',
      systemRole: 'principal',
      channel,
      initiatedAt: '2026-11-07T10:00:00.000Z',
      ...(authenticated !== undefined ? { authenticated } : {}),
    },
  };
}

describe('isPrincipalDirectedMailboxSend', () => {
  it.each(['signal', 'voice', 'web'])('is true for a live principal turn on %s', (channel) => {
    expect(isPrincipalDirectedMailboxSend({ liveTurn: true, taskMetadata: principalMeta(channel) })).toBe(true);
  });

  it('is false for an approval replay', () => {
    expect(isPrincipalDirectedMailboxSend({ liveTurn: true, taskMetadata: principalMeta('signal'), humanApproved: true })).toBe(false);
  });

  it('is false for an email-originated turn whose sender was not verified', () => {
    expect(isPrincipalDirectedMailboxSend({ liveTurn: true, taskMetadata: principalMeta('email') })).toBe(false);
    expect(isPrincipalDirectedMailboxSend({ liveTurn: true, taskMetadata: principalMeta('email', false) })).toBe(false);
  });

  it('is true for an email-originated turn whose sender was verified', () => {
    expect(isPrincipalDirectedMailboxSend({ liveTurn: true, taskMetadata: principalMeta('email', true) })).toBe(true);
  });

  it('is false without liveTurn', () => {
    expect(isPrincipalDirectedMailboxSend({ taskMetadata: principalMeta('signal') })).toBe(false);
    expect(isPrincipalDirectedMailboxSend({ liveTurn: false, taskMetadata: principalMeta('signal') })).toBe(false);
  });

  it('is false for a system originator', () => {
    const meta = { originator: { contactId: 'system', systemRole: 'system', channel: 'scheduler', initiatedAt: '2026-11-07T10:00:00.000Z' } };
    expect(isPrincipalDirectedMailboxSend({ liveTurn: true, taskMetadata: meta })).toBe(false);
  });

  it('is false with no metadata', () => {
    expect(isPrincipalDirectedMailboxSend({ liveTurn: true })).toBe(false);
  });
});
