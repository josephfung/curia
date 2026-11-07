// contact-link-identity (#2041): agent-entered addresses carry agent_stated, pass the
// duplicate check first, and re-stating an address an agent typed earlier verifies it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { ContactLinkIdentityHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { sourceKeyFor, sourceKeysInText, type IdentifierSources } from '../../../../src/contacts/identifier-provenance.js';

const silentLog = pino({ level: 'silent' });

// Most cases here are about the duplicate check, so every identifier has a source unless
// a case says otherwise. Provenance cases pass their own (#2061).
const EVERYTHING_SOURCED: IdentifierSources = { has: async () => true };

function makeCtx(
  contactService: ContactService,
  input: Record<string, unknown>,
  extra: Partial<ToolContext> = { identifierSources: EVERYTHING_SOURCED },
): ToolContext {
  return { input, secret: () => 'unused', log: silentLog, contactService, ...extra } as unknown as ToolContext;
}

function sourcesFrom(text: string): IdentifierSources {
  const keys = sourceKeysInText(text);
  return { has: async (channel, identifier) => keys.has(sourceKeyFor(channel, identifier)) };
}

describe('ContactLinkIdentityHandler', () => {
  let contacts: ContactService;
  let handler: ContactLinkIdentityHandler;
  let danaId: string;
  let priyaId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    handler = new ContactLinkIdentityHandler();
    const dana = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'ceo_stated' });
    danaId = dana.id;
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya@example.test', source: 'ceo_stated' });
  });

  it('links a new address as agent_stated and verified', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: danaId, channel: 'email', identifier: 'Dana@NewCo.example', label: 'work',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: false } });
    const found = await contacts.getContactWithIdentities(danaId);
    expect(found!.identities[0]).toMatchObject({
      channelIdentifier: 'dana@newco.example', source: 'agent_stated', verified: true, label: 'work',
    });
  });

  it('refuses an address another contact holds, naming that contact', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'email', identifier: 'priya@example.test' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(priyaId);
      expect(result.error).toMatch(/Nothing was linked/);
      expect(result.error).not.toContain('priya@example.test');
    }
  });

  it('refuses a near-miss of another contact address until distinct_from names that contact', async () => {
    const input = { contact_id: danaId, channel: 'email', identifier: 'priya@exmaple.test' };
    const refused = await handler.execute(makeCtx(contacts, input));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toContain(`"Priya Natarajan" (${priyaId}): similar email address`);
    const retried = await handler.execute(makeCtx(contacts, { ...input, distinct_from: [priyaId] }));
    expect(retried.success).toBe(true);
  });

  it('re-stating a verified address on this contact changes nothing', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: priyaId, channel: 'email', identifier: 'Priya@Example.test' }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    expect((await contacts.getContactWithIdentities(priyaId))!.identities).toHaveLength(1);
  });

  it('re-stating an unverified outbound_recipient address verifies it, keeping its source', async () => {
    const recipient = await contacts.createContact({ displayName: 'new.person@cold.example', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: recipient.id, channel: 'email', channelIdentifier: 'new.person@cold.example', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: recipient.id, channel: 'email', identifier: 'new.person@cold.example',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    const identity = (await contacts.getContactWithIdentities(recipient.id))!.identities[0];
    expect(identity).toMatchObject({ source: 'outbound_recipient', verified: true });
  });

  // Verifying is the risky step: the 2026-10-07 incident address was a gateway-recorded
  // typo of the principal's. A re-statement runs the same duplicate check a new address does.
  describe('re-stating an outbound_recipient address runs the duplicate check before verifying', () => {
    let recipientId: string;

    beforeEach(async () => {
      const recipient = await contacts.createContact({ displayName: 'Cold Recipient', source: 'outbound_recipient' });
      recipientId = recipient.id;
      await contacts.linkIdentity({
        contactId: recipientId, channel: 'email', channelIdentifier: 'priya@exmaple.test', source: 'outbound_recipient',
      });
    });

    const restate = (extra: Record<string, unknown> = {}): Promise<Awaited<ReturnType<ContactLinkIdentityHandler['execute']>>> =>
      handler.execute(makeCtx(contacts, { contact_id: recipientId, channel: 'email', identifier: 'priya@exmaple.test', ...extra }));
    const isVerified = async (): Promise<boolean> =>
      (await contacts.getContactWithIdentities(recipientId))!.identities[0]!.verified;

    it('refuses a near miss of another contact address, naming that contact and no address', async () => {
      const result = await restate();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain(`"Priya Natarajan" (${priyaId}): similar email address`);
        expect(result.error).toMatch(/Nothing was verified/);
        expect(result.error).toMatch(/distinct_from/);
        expect(result.error).not.toContain('priya@example.test');
        expect(result.error).not.toContain('priya@exmaple.test');
      }
      expect(await isVerified()).toBe(false);
    });

    // #2498: agent_called and agent_stated rows are verified in place too, so the same
    // duplicate check has to refuse them.
    it.each(['agent_called', 'agent_stated'] as const)(
      'refuses a near miss of another contact address for an unverified %s address, verifying nothing',
      async (source) => {
        const typed = await contacts.createContact({ displayName: 'Typed Recipient', source });
        await contacts.linkIdentity({
          contactId: typed.id, channel: 'email', channelIdentifier: 'priya@exampel.test', source,
        });
        const result = await handler.execute(makeCtx(contacts, {
          contact_id: typed.id, channel: 'email', identifier: 'priya@exampel.test',
        }));
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain(`"Priya Natarajan" (${priyaId}): similar email address`);
          expect(result.error).toMatch(/Nothing was verified/);
        }
        expect((await contacts.getContactWithIdentities(typed.id))!.identities[0]!.verified).toBe(false);
      },
    );

    it('verifies it once distinct_from names that contact', async () => {
      const result = await restate({ distinct_from: [priyaId] });
      expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
      expect(await isVerified()).toBe(true);
    });

    it('refuses, and verifies nothing, when the duplicate check cannot run', async () => {
      vi.spyOn(contacts, 'findLikelyDuplicates').mockRejectedValueOnce(new Error('connection reset'));
      const result = await restate({ distinct_from: [priyaId] });
      expect(result).toEqual({ success: false, error: 'The duplicate check could not run. Nothing was verified. Try again.' });
      expect(await isVerified()).toBe(false);
    });

    it('refuses when another contact holds the same number in another format', async () => {
      const other = await contacts.createContact({ displayName: 'Sam Other', source: 'ceo_stated' });
      await contacts.linkIdentity({
        contactId: other.id, channel: 'sms', channelIdentifier: '+1 (416) 555-0188', source: 'ceo_stated',
      });
      await contacts.linkIdentity({
        contactId: recipientId, channel: 'sms', channelIdentifier: '+14165550188', source: 'outbound_recipient',
      });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: recipientId, channel: 'sms', identifier: '+14165550188', distinct_from: [other.id],
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain(`"Sam Other" (${other.id})`);
        expect(result.error).toMatch(/Nothing was verified/);
        expect(result.error).not.toContain('5550188');
      }
      const sms = (await contacts.getContactWithIdentities(recipientId))!.identities.find((i) => i.channel === 'sms');
      expect(sms!.verified).toBe(false);
    });

    it('verifies with no check when the address is already verified (nothing changes)', async () => {
      await contacts.verifyIdentity((await contacts.getContactWithIdentities(recipientId))!.identities[0]!.id);
      const spy = vi.spyOn(contacts, 'findLikelyDuplicates');
      const result = await restate();
      expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('finds a stored number when it is re-stated in another format (Review Focus 5)', async () => {
    const recipient = await contacts.createContact({ displayName: 'Text Only', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: recipient.id, channel: 'sms', channelIdentifier: '+14165550100', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: recipient.id, channel: 'sms', identifier: '+1 (416) 555-0100',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    expect((await contacts.getContactWithIdentities(recipient.id))!.identities).toHaveLength(1);
  });

  it.each(['self_claimed', 'sms_participant'] as const)('will not vouch for an unverified %s address', async (source) => {
    await contacts.linkIdentity({ contactId: danaId, channel: 'sms', channelIdentifier: '+14165550199', source });
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'sms', identifier: '+14165550199' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Only the principal can vouch for it/);
      // Names both routes, not just "the console" (the principal may be in the console's chat).
      expect(result.error).toMatch(/asking Curia directly in a live conversation/);
      expect(result.error).toMatch(/identity editor/);
      expect(result.error).not.toContain('5550199');
    }
    expect((await contacts.getContactWithIdentities(danaId))!.identities[0]!.verified).toBe(false);
  });

  // #2515: on a live principal turn, the principal vouches for an unverified address of
  // any source, after the same duplicate and provenance checks.
  describe('re-stating an unverified address on a live principal turn', () => {
    const PRINCIPAL_METADATA = {
      originator: { contactId: 'principal-contact', systemRole: 'principal', channel: 'http', initiatedAt: '2026-11-05T15:00:00Z', tier: 'principal' },
    };
    const LIVE: Partial<ToolContext> = {
      identifierSources: sourcesFrom('Can you verify them as office@acme.example, then try the drafts again'),
      liveTurn: true,
      taskMetadata: PRINCIPAL_METADATA,
    };
    let acmeId: string;

    const restate = (extra: Partial<ToolContext>, input: Record<string, unknown> = {}) =>
      handler.execute(makeCtx(contacts, { contact_id: acmeId, channel: 'email', identifier: 'office@acme.example', ...input }, extra));
    const isVerified = async (): Promise<boolean> =>
      (await contacts.getContactWithIdentities(acmeId))!.identities[0]!.verified;

    beforeEach(async () => {
      acmeId = (await contacts.createContact({ displayName: 'Acme Office', source: 'agent_called' })).id;
    });

    it.each(['agent_called', 'agent_stated', 'self_claimed'] as const)('verifies an unverified %s address, keeping its source', async (source) => {
      await contacts.linkIdentity({ contactId: acmeId, channel: 'email', channelIdentifier: 'office@acme.example', source, verified: false });
      expect(await isVerified()).toBe(false);
      const result = await restate(LIVE);
      expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
      expect((await contacts.getContactWithIdentities(acmeId))!.identities[0]).toMatchObject({ source, verified: true });
    });

    it('verifies on a replay the principal approved, after the voice grant lapsed', async () => {
      await contacts.linkIdentity({
        contactId: acmeId, channel: 'email', channelIdentifier: 'office@acme.example', source: 'self_claimed', verified: false,
      });
      const result = await restate({ ...LIVE, liveTurn: false, liveTurnGrantId: 'ltg-lapsed', humanApproved: true });
      expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
      expect(await isVerified()).toBe(true);
    });

    describe('refuses, and leaves it unverified', () => {
      beforeEach(async () => {
        await contacts.linkIdentity({
          contactId: acmeId, channel: 'email', channelIdentifier: 'office@acme.example', source: 'self_claimed', verified: false,
        });
      });

      it.each([
        ['principal lineage with no live turn (a woken or scheduled task)', { liveTurn: undefined }],
        ['a woken task that a live-turn flag leaked onto', { taskMetadata: { ...PRINCIPAL_METADATA, wakeContext: { derived: false } } }],
        ['a live-turn flag without principal lineage', { taskMetadata: { originator: { contactId: 'agent', systemRole: 'agent', channel: 'internal', initiatedAt: '2026-11-05T15:00:00Z', tier: null } } }],
        ['no task metadata at all', { taskMetadata: undefined }],
      ] as const)('%s', async (_label, override) => {
        const result = await restate({ ...LIVE, ...override });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error).toMatch(/Only the principal can vouch for it/);
        expect(await isVerified()).toBe(false);
      });

      it('an address with no source in the conversation', async () => {
        const result = await restate({ ...LIVE, identifierSources: sourcesFrom('verify the Acme address please') });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('appears in no message a person sent');
          expect(result.error).toContain('Nothing was verified.');
          expect(result.error).not.toContain('office@acme.example');
        }
        expect(await isVerified()).toBe(false);
      });

      it('an address another contact holds', async () => {
        // The store cannot hold one address on two contacts, so the check's answer is stubbed:
        // the same number in another format, as in the outbound_recipient case above.
        const other = await contacts.createContact({ displayName: 'Acme Holding', source: 'ceo_stated' });
        vi.spyOn(contacts, 'findLikelyDuplicates').mockResolvedValueOnce({ taken: [{ contact: other, channel: 'email' }], candidates: [] });
        const result = await restate(LIVE);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain(other.id);
          expect(result.error).toContain('Nothing was verified.');
        }
        expect(await isVerified()).toBe(false);
      });

      it('an address resembling another contact\'s until distinct_from names that contact', async () => {
        const similarId = (await contacts.createContact({ displayName: 'Acme Partners', source: 'ceo_stated' })).id;
        await contacts.linkIdentity({ contactId: similarId, channel: 'email', channelIdentifier: 'office@acme.exmaple', source: 'ceo_stated' });
        const refused = await restate(LIVE);
        expect(refused.success).toBe(false);
        if (!refused.success) {
          expect(refused.error).toContain(`"Acme Partners" (${similarId}): similar email address`);
          expect(refused.error).toContain('Nothing was verified.');
        }
        expect(await isVerified()).toBe(false);

        const retried = await restate(LIVE, { distinct_from: [similarId] });
        expect(retried).toMatchObject({ success: true, data: { verified: true } });
      });
    });

    it('still refuses a structural contact on a live turn', async () => {
      const principal = await contacts.createContact({ displayName: 'Joseph Fung', source: 'ceo_stated' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      await contacts.linkIdentity({
        contactId: principal.id, channel: 'email', channelIdentifier: 'office@acme.example', source: 'agent_called', verified: false,
      });
      const result = await handler.execute(makeCtx(contacts,
        { contact_id: principal.id, channel: 'email', identifier: 'office@acme.example' }, LIVE));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/managed by the principal, in the console/);
      expect((await contacts.getContactWithIdentities(principal.id))!.identities[0]!.verified).toBe(false);
    });
  });

  it('refuses an unknown contact ID and a malformed identifier', async () => {
    const missing = await handler.execute(makeCtx(contacts, {
      contact_id: '00000000-0000-4000-8000-000000000000', channel: 'email', identifier: 'x@y.example',
    }));
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toMatch(/No contact has ID/);
    const malformed = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'sms', identifier: 'call me' }));
    expect(malformed.success).toBe(false);
  });

  // Structural contacts (systemRole non-null): the principal's verified identities are
  // trusted as the principal by Gate C and the "principal" alias, so an agent must not
  // be able to add to, re-state, or verify any of them.
  describe('structural contacts', () => {
    it('refuses a new address on the principal, without leaking the principal contact ID', async () => {
      const principal = await contacts.createContact({ displayName: 'Joseph Fung', source: 'ceo_stated' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: principal.id, channel: 'email', identifier: 'attacker@evil.example',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("The principal's addresses are managed by the principal, in the console. Nothing was linked.");
        expect(result.error).not.toContain(principal.id);
      }
      expect((await contacts.getContactWithIdentities(principal.id))!.identities).toHaveLength(0);
    });

    it('refuses re-stating an existing verified address on the principal, changing nothing', async () => {
      const principal = await contacts.createContact({ displayName: 'Joseph Fung', source: 'ceo_stated' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      await contacts.linkIdentity({
        contactId: principal.id, channel: 'email', channelIdentifier: 'joseph@example.test', source: 'ceo_stated',
      });
      const before = (await contacts.getContactWithIdentities(principal.id))!.identities;
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ verified: true });

      const result = await handler.execute(makeCtx(contacts, {
        contact_id: principal.id, channel: 'email', identifier: 'Joseph@Example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/managed by the principal, in the console/);
        expect(result.error).not.toContain(principal.id);
      }
      const after = (await contacts.getContactWithIdentities(principal.id))!.identities;
      expect(after).toEqual(before);
    });

    it('refuses verifying an unverified outbound_recipient address on the principal', async () => {
      const principal = await contacts.createContact({ displayName: 'Joseph Fung', source: 'ceo_stated' });
      await contacts.saveContact({ ...principal, systemRole: 'principal' });
      await contacts.linkIdentity({
        contactId: principal.id, channel: 'email', channelIdentifier: 'joseph.alt@example.test', source: 'outbound_recipient',
      });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: principal.id, channel: 'email', identifier: 'joseph.alt@example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/managed by the principal, in the console/);
        expect(result.error).not.toContain(principal.id);
      }
      expect((await contacts.getContactWithIdentities(principal.id))!.identities[0]!.verified).toBe(false);
    });

    it.each(['agent', 'system'] as const)('refuses a new address on a %s system-role contact', async (systemRole) => {
      const structural = await contacts.createContact({ displayName: 'Curia Internal', source: 'ceo_stated' });
      await contacts.saveContact({ ...structural, systemRole });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: structural.id, channel: 'email', identifier: 'curia@example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('This is a system contact; its addresses are not managed by agents. Nothing was linked.');
      }
      expect((await contacts.getContactWithIdentities(structural.id))!.identities).toHaveLength(0);
    });

    // isStructuralContact, not systemRole alone: a principal or agent row whose system
    // role was never set is still off limits.
    it.each([
      ['kind principal', { kind: 'principal' }],
      ['kind agent', { kind: 'agent' }],
      ['tier principal', { tier: 'principal' }],
    ] as const)('refuses a contact with no system role but %s', async (_label, fields) => {
      const structural = await contacts.createContact({ displayName: 'Curia Internal', source: 'ceo_stated' });
      await contacts.saveContact({ ...structural, ...fields });
      const result = await handler.execute(makeCtx(contacts, {
        contact_id: structural.id, channel: 'email', identifier: 'curia@example.test',
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('This is a system contact; its addresses are not managed by agents. Nothing was linked.');
      }
      expect((await contacts.getContactWithIdentities(structural.id))!.identities).toHaveLength(0);
    });
  });
});

describe('ContactLinkIdentityHandler — identifier provenance (#2061)', () => {
  let contacts: ContactService;
  let danaId: string;
  const handler = new ContactLinkIdentityHandler();

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    const dana = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'ceo_stated' });
    danaId = dana.id;
  });

  it('links an address found in a source as verified', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'email', identifier: 'dana@newco.example' },
      { identifierSources: sourcesFrom('Her new address is dana@newco.example') }));
    expect(result).toMatchObject({ success: true, data: { verified: true } });
  });

  it('refuses a new address with no source and links nothing', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'email', identifier: 'dana@newcoo.example' },
      { identifierSources: sourcesFrom('Her new address is dana@newco.example') }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('Nothing was linked.');
    expect(result.error).not.toContain('dana@newcoo.example');
    expect((await contacts.getContactWithIdentities(danaId))!.identities).toHaveLength(0);
  });

  // #2498: agent_called (contact-register) and agent_stated rows were refused as
  // principal-only, so a sourced address could never be verified by an agent.
  it.each(['outbound_recipient', 'agent_called', 'agent_stated'] as const)(
    're-states an unverified %s address only when it has a source, keeping its source',
    async (source) => {
      await contacts.linkIdentity({ contactId: danaId, channel: 'email', channelIdentifier: 'dana@newco.example', source });
      const input = { contact_id: danaId, channel: 'email', identifier: 'dana@newco.example' };

      const refused = await handler.execute(makeCtx(contacts, input, { identifierSources: sourcesFrom('nothing here') }));
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain('Nothing was verified.');
        expect(refused.error).not.toMatch(/Only the principal/);
      }
      expect((await contacts.getContactWithIdentities(danaId))!.identities[0]!.verified).toBe(false);

      const verified = await handler.execute(makeCtx(contacts, input, { identifierSources: sourcesFrom('dana@newco.example') }));
      expect(verified).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
      expect((await contacts.getContactWithIdentities(danaId))!.identities[0]).toMatchObject({ source, verified: true });
    },
  );

  it.each(['self_claimed', 'sms_participant'] as const)(
    'refuses an unverified %s address even when it has a source, saying why',
    async (source) => {
      await contacts.linkIdentity({ contactId: danaId, channel: 'sms', channelIdentifier: '+14165550199', source });
      const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'sms', identifier: '+14165550199' },
        { identifierSources: sourcesFrom('Text me at +1 416 555 0199') }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/Only the principal can vouch for it/);
        expect(result.error).toMatch(source === 'self_claimed' ? /about themselves/ : /spoofed/);
      }
      expect((await contacts.getContactWithIdentities(danaId))!.identities[0]!.verified).toBe(false);
    },
  );

  // #2447: a number already verified on a sibling phone-family channel of this contact
  // needs no source in the conversation. It is linked as a derived row.
  describe('derivation from a verified number on the contact', () => {
    const NOTHING_SOURCED: Partial<ToolContext> = { identifierSources: sourcesFrom('nothing here') };

    it('links an unsourced number matching a verified phone identity as a derived row', async () => {
      const phone = await contacts.linkIdentity({
        contactId: danaId, channel: 'phone', channelIdentifier: '+14165550100', source: 'crm_import', label: 'office',
      });
      const result = await handler.execute(makeCtx(contacts,
        { contact_id: danaId, channel: 'sms', identifier: '(416) 555-0100' }, NOTHING_SOURCED));
      expect(result).toMatchObject({
        success: true, data: { verified: true, already_linked: false, derived_from: 'phone' },
      });
      const sms = (await contacts.getContactWithIdentities(danaId))!.identities.find((i) => i.channel === 'sms');
      expect(sms).toMatchObject({
        channelIdentifier: '+14165550100', source: 'derived', verified: true, derivedFromIdentityId: phone.id, label: 'office',
      });
    });

    it('stores the label the agent passed', async () => {
      await contacts.linkIdentity({ contactId: danaId, channel: 'signal', channelIdentifier: '+14165550100', source: 'signal_participant' });
      const result = await handler.execute(makeCtx(contacts,
        { contact_id: danaId, channel: 'phone', identifier: '+14165550100', label: 'mobile' }, NOTHING_SOURCED));
      expect(result.success).toBe(true);
      const phone = (await contacts.getContactWithIdentities(danaId))!.identities.find((i) => i.channel === 'phone');
      expect(phone).toMatchObject({ source: 'derived', label: 'mobile' });
    });

    it('still refuses an unsourced number that matches nothing on the contact', async () => {
      await contacts.linkIdentity({ contactId: danaId, channel: 'phone', channelIdentifier: '+14165550100', source: 'crm_import' });
      const result = await handler.execute(makeCtx(contacts,
        { contact_id: danaId, channel: 'sms', identifier: '+14165550199' }, NOTHING_SOURCED));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('Nothing was linked.');
      expect((await contacts.getContactWithIdentities(danaId))!.identities).toHaveLength(1);
    });

    it('does not derive from an unverified number', async () => {
      await contacts.linkIdentity({ contactId: danaId, channel: 'sms', channelIdentifier: '+14165550100', source: 'sms_participant' });
      const result = await handler.execute(makeCtx(contacts,
        { contact_id: danaId, channel: 'signal', identifier: '+14165550100' }, NOTHING_SOURCED));
      expect(result.success).toBe(false);
    });

    it('lists another contact with the number on a sibling channel until distinct_from names it', async () => {
      const priyaId = (await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' })).id;
      await contacts.linkIdentity({ contactId: danaId, channel: 'phone', channelIdentifier: '+14165550100', source: 'crm_import' });
      await contacts.linkIdentity({ contactId: priyaId, channel: 'signal', channelIdentifier: '+14165550100', source: 'signal_participant' });
      const input = { contact_id: danaId, channel: 'sms', identifier: '+14165550100' };

      const refused = await handler.execute(makeCtx(contacts, input, NOTHING_SOURCED));
      expect(refused.success).toBe(false);
      if (!refused.success) {
        expect(refused.error).toContain(`"Priya Natarajan" (${priyaId}): same number on signal`);
        expect(refused.error).not.toContain('5550100');
      }

      const linked = await handler.execute(makeCtx(contacts, { ...input, distinct_from: [priyaId] }, NOTHING_SOURCED));
      expect(linked).toMatchObject({ success: true, data: { derived_from: 'phone' } });
    });
  });
});
