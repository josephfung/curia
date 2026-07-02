import { describe, it, expect } from 'vitest';
import type { ChannelIdentity } from './types.js';
import {
  isPrincipalEmail,
  isPrincipalSignal,
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
        { recipient: '+15551234567', message: 'heads up' },
        PRINCIPAL_IDENTITIES,
      )).toBe(true);
    });

    it('rejects signal group sends', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        { recipient: '+15551234567', group_id: 'group-abc', message: 'hi' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('detects email-send to the principal only', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        { to: 'ceo@example.com', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(true);
    });

    it('rejects mixed principal + cc recipient set', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        { to: 'ceo@example.com', cc: 'other@example.com', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });

    it('rejects spoofed display name in to field', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        { to: 'CEO', subject: 'x', body: 'y' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
    });
  });
});
