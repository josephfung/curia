import { describe, it, expect } from 'vitest';
import type { ChannelIdentity } from './types.js';
import {
  isPrincipalEmail,
  isPrincipalSignal,
  isPrincipalSlack,
  computePrincipalIsSoleRecipient,
  resolvePrincipalIsSoleRecipientFromSkillInput,
} from './principal-recipient.js';

function makeIdentity(channel: string, identifier: string): ChannelIdentity {
  return {
    id: 'id-1',
    contactId: 'principal-1',
    channel,
    channelIdentifier: identifier,
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const PRINCIPAL_IDENTITIES = [
  makeIdentity('email', 'ceo@example.com'),
  makeIdentity('signal', '+15551234567'),
  makeIdentity('slack', 'U_CEO'),
];

describe('principal-recipient', () => {
  describe('isPrincipalEmail', () => {
    it('matches verified principal email case-insensitively', () => {
      expect(isPrincipalEmail('CEO@example.com', PRINCIPAL_IDENTITIES)).toBe(true);
    });

    it('rejects unverified-looking display names', () => {
      expect(isPrincipalEmail('CEO', PRINCIPAL_IDENTITIES)).toBe(false);
    });
  });

  describe('isPrincipalSignal', () => {
    it('matches verified principal Signal identity exactly', () => {
      expect(isPrincipalSignal('+15551234567', PRINCIPAL_IDENTITIES)).toBe(true);
    });

    it('rejects a different phone number', () => {
      expect(isPrincipalSignal('+15559999999', PRINCIPAL_IDENTITIES)).toBe(false);
    });
  });

  describe('isPrincipalSlack', () => {
    it('matches verified principal Slack user id exactly', () => {
      expect(isPrincipalSlack('U_CEO', PRINCIPAL_IDENTITIES)).toBe(true);
    });

    it('rejects a different Slack user id', () => {
      expect(isPrincipalSlack('U_OTHER', PRINCIPAL_IDENTITIES)).toBe(false);
    });

    it('rejects conversation ids (D…/C…)', () => {
      expect(isPrincipalSlack('D123', PRINCIPAL_IDENTITIES)).toBe(false);
      expect(isPrincipalSlack('C123', PRINCIPAL_IDENTITIES)).toBe(false);
    });
  });

  describe('computePrincipalIsSoleRecipient', () => {
    it('is true for a single principal recipient', () => {
      expect(computePrincipalIsSoleRecipient([
        { identifier: 'ceo@example.com', isPrincipal: true },
      ])).toBe(true);
    });

    it('is false for principal plus a non-principal', () => {
      expect(computePrincipalIsSoleRecipient([
        { identifier: 'ceo@example.com', isPrincipal: true },
        { identifier: 'other@example.com', isPrincipal: false },
      ])).toBe(false);
    });

    it('dedupes repeated principal addresses', () => {
      expect(computePrincipalIsSoleRecipient([
        { identifier: 'ceo@example.com', isPrincipal: true },
        { identifier: 'CEO@example.com', isPrincipal: true },
      ])).toBe(true);
    });
  });

  describe('resolvePrincipalIsSoleRecipientFromSkillInput', () => {
    it('detects signal-send to the principal only', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'signal-send',
        { recipient: '+15551234567', message: 'heads up' },
        PRINCIPAL_IDENTITIES,
      )).toBe(true);
    });

    it('rejects signal group sends', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'signal-send',
        { recipient: '+15551234567', group_id: 'group-abc', message: 'hi' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('detects email-send to the principal only', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'email-send',
        { to: 'ceo@example.com', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(true);
    });

    it('rejects mixed principal + cc recipient set', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'email-send',
        { to: 'ceo@example.com', cc: 'other@example.com', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('rejects comma-joined to with principal and a third party', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'email-send',
        { to: 'ceo@example.com, other@example.com', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('rejects spoofed display name in to field', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'email-send',
        { to: 'CEO', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('fails closed when email-send input includes unparsed bcc', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'email-send',
        { to: 'ceo@example.com', bcc: 'other@example.com', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('fails closed when email-send to is an array', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'email-send',
        { to: ['ceo@example.com'], subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('fails closed for skills not on the allowlist even when to matches the principal', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'custom-notify',
        { to: 'ceo@example.com' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('fails closed when signal-send input includes unparsed recipients key', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'signal-send',
        { recipient: '+15551234567', recipients: ['+15559999999'], message: 'hi' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });
  });
});
