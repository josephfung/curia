import { describe, it, expect } from 'vitest';
import type { ChannelIdentity } from './types.js';
import {
  isPrincipalIdentity,
  computePrincipalIsSoleRecipient,
  resolvePrincipalIsSoleRecipientFromSkillInput,
  GATE_C_PRINCIPAL_CARVEOUT_SKILLS,
} from './principal-recipient.js';
import {
  PRINCIPAL_CHANNEL_RULES,
  assertPrincipalChannelRegistryUnique,
  findPrincipalChannelRules,
} from './principal-channel-registry.js';
import type { PrincipalChannelRules } from './principal-channel-rules.js';

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
  makeIdentity('sms', '+15559876543'),
];

describe('principal-recipient', () => {
  describe('GATE_C_PRINCIPAL_CARVEOUT_SKILLS', () => {
    it('opts in email-send, signal-send, sms-send, and slack-send', () => {
      expect([...GATE_C_PRINCIPAL_CARVEOUT_SKILLS].sort()).toEqual([
        'email-send',
        'signal-send',
        'slack-send',
        'sms-send',
      ]);
      const slack = PRINCIPAL_CHANNEL_RULES.find((r) => r.channel === 'slack');
      expect(slack).toBeDefined();
      expect(slack!.carveoutSkill?.skillName).toBe('slack-send');
    });

    it('rejects duplicate channel ids and carve-out skill names', () => {
      expect(() => assertPrincipalChannelRegistryUnique(PRINCIPAL_CHANNEL_RULES)).not.toThrow();

      const dupChannel: PrincipalChannelRules = {
        channel: 'email',
        identifiersEqual: (a, b) => a === b,
        extractRecipients: () => null,
      };
      expect(() =>
        assertPrincipalChannelRegistryUnique([...PRINCIPAL_CHANNEL_RULES, dupChannel]),
      ).toThrow(/duplicate channel 'email'/);

      const dupSkill: PrincipalChannelRules = {
        channel: 'other',
        identifiersEqual: (a, b) => a === b,
        extractRecipients: () => null,
        carveoutSkill: {
          skillName: 'email-send',
          parseRecipients: () => [],
        },
      };
      expect(() =>
        assertPrincipalChannelRegistryUnique([...PRINCIPAL_CHANNEL_RULES, dupSkill]),
      ).toThrow(/duplicate carveout skill 'email-send'/);
    });
  });

  describe('isPrincipalIdentity', () => {
    it('matches verified principal email case-insensitively', () => {
      expect(isPrincipalIdentity('email', 'CEO@example.com', PRINCIPAL_IDENTITIES)).toBe(true);
    });

    it('rejects unverified-looking display names for email', () => {
      expect(isPrincipalIdentity('email', 'CEO', PRINCIPAL_IDENTITIES)).toBe(false);
    });

    it('matches verified principal Signal identity exactly', () => {
      expect(isPrincipalIdentity('signal', '+15551234567', PRINCIPAL_IDENTITIES)).toBe(true);
    });

    it('rejects a different Signal phone number', () => {
      expect(isPrincipalIdentity('signal', '+15559999999', PRINCIPAL_IDENTITIES)).toBe(false);
    });

    it('matches verified principal Slack user id exactly', () => {
      expect(isPrincipalIdentity('slack', 'U_CEO', PRINCIPAL_IDENTITIES)).toBe(true);
    });

    it('rejects a different Slack user id', () => {
      expect(isPrincipalIdentity('slack', 'U_OTHER', PRINCIPAL_IDENTITIES)).toBe(false);
    });

    it('rejects Slack conversation ids (D…/C…)', () => {
      expect(isPrincipalIdentity('slack', 'D123', PRINCIPAL_IDENTITIES)).toBe(false);
      expect(isPrincipalIdentity('slack', 'C123', PRINCIPAL_IDENTITIES)).toBe(false);
    });

    it('matches verified principal SMS identity exactly', () => {
      expect(isPrincipalIdentity('sms', '+15559876543', PRINCIPAL_IDENTITIES)).toBe(true);
    });

    it('rejects a different SMS phone number', () => {
      expect(isPrincipalIdentity('sms', '+15551234567', PRINCIPAL_IDENTITIES)).toBe(false);
    });

    it('fails closed for an unregistered channel', () => {
      expect(isPrincipalIdentity('telegram', 'ceo@example.com', PRINCIPAL_IDENTITIES)).toBe(false);
    });
  });

  describe('extractRecipients registry fail-closed', () => {
    it('returns undefined rules for an unregistered channel (no gateway carve-out)', () => {
      expect(findPrincipalChannelRules('telegram')).toBeUndefined();
    });

    it('every registered channel contributes extractRecipients', () => {
      for (const rules of PRINCIPAL_CHANNEL_RULES) {
        expect(typeof rules.extractRecipients).toBe('function');
      }
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

    it('detects sms-send to the principal only', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'sms-send',
        { recipient: '+15559876543', message: 'heads up' },
        PRINCIPAL_IDENTITIES,
      )).toBe(true);
    });

    it('rejects sms-send to a non-principal number', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'sms-send',
        { recipient: '+15551234567', message: 'heads up' },
        PRINCIPAL_IDENTITIES,
      )).toBe(false);
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

    it('opts in slack-send when recipient is the principal Slack user id', () => {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(
        'slack-send',
        { recipient: 'U_CEO', message: 'hi' },
        PRINCIPAL_IDENTITIES,
      )).toBe(true);
    });
  });
});
