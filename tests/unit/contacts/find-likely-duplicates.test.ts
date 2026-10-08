// The duplicate check contact-create and contact-link-identity run before an
// agent-entered address is stored (#2041). One test per row of the spec's table.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';

describe('ContactService.findLikelyDuplicates', () => {
  let contacts: ContactService;
  let priyaId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya@example.test', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: priya.id, channel: 'signal', channelIdentifier: '+14165550100', source: 'ceo_stated' });
  });

  it('reports an identifier another contact holds on the same channel as taken (email ignores case)', async () => {
    // The same name too, so Priya would also be a same_name candidate: a taken contact is
    // reported once, as taken, and dropped from the candidates.
    const check = await contacts.findLikelyDuplicates({
      displayName: 'Priya Natarajan',
      identities: [{ channel: 'email', identifier: 'PRIYA@example.test' }],
    });
    expect(check.taken).toHaveLength(1);
    expect(check.taken[0]!.contact.id).toBe(priyaId);
    expect(check.taken[0]!.channel).toBe('email');
    expect(check.candidates).toEqual([]);
  });

  it('compares numbers by digits, so formatting does not hide a taken number', async () => {
    const check = await contacts.findLikelyDuplicates({ identities: [{ channel: 'signal', identifier: '+1 (416) 555-0100' }] });
    expect(check.taken.map((t) => t.contact.id)).toEqual([priyaId]);
  });

  it('reports the same number on a sibling phone channel as a candidate', async () => {
    const check = await contacts.findLikelyDuplicates({ identities: [{ channel: 'sms', identifier: '+14165550100' }] });
    expect(check.taken).toEqual([]);
    expect(check.candidates).toEqual([
      { contact: expect.objectContaining({ id: priyaId }), reasons: [{ kind: 'same_number', channel: 'signal' }] },
    ]);
  });

  it('reports a near-miss email and a near-miss number as similar_address', async () => {
    const email = await contacts.findLikelyDuplicates({ identities: [{ channel: 'email', identifier: 'priya@exmaple.test' }] });
    expect(email.candidates[0]?.reasons).toEqual([{ kind: 'similar_address', channel: 'email' }]);
    const number = await contacts.findLikelyDuplicates({ identities: [{ channel: 'sms', identifier: '+14165550101' }] });
    expect(number.candidates[0]?.reasons).toEqual([{ kind: 'similar_address', channel: 'signal' }]);
  });

  it('reports the same display name, ignoring case and spacing', async () => {
    const check = await contacts.findLikelyDuplicates({ displayName: '  priya   NATARAJAN ', identities: [] });
    expect(check.candidates).toEqual([
      { contact: expect.objectContaining({ id: priyaId }), reasons: [{ kind: 'same_name' }] },
    ]);
  });

  it('does not report a name that only contains the other', async () => {
    const check = await contacts.findLikelyDuplicates({ displayName: 'Priya', identities: [] });
    expect(check.candidates).toEqual([]);
  });

  it('collects every reason for one contact in one candidate', async () => {
    const check = await contacts.findLikelyDuplicates({
      displayName: 'Priya Natarajan',
      identities: [{ channel: 'email', identifier: 'priya@exmaple.test' }],
    });
    expect(check.candidates).toHaveLength(1);
    expect(check.candidates[0]!.reasons).toEqual([
      { kind: 'similar_address', channel: 'email' },
      { kind: 'same_name' },
    ]);
  });

  it('never reports the contact being added to', async () => {
    const check = await contacts.findLikelyDuplicates({
      identities: [{ channel: 'email', identifier: 'priya@example.test' }],
      excludeContactId: priyaId,
    });
    expect(check).toEqual({ taken: [], candidates: [] });
  });

  it('matches Slack ids exactly and never as a near miss', async () => {
    await contacts.linkIdentity({ contactId: priyaId, channel: 'slack', channelIdentifier: 'U012ABCDEF', source: 'ceo_stated' });
    const near = await contacts.findLikelyDuplicates({ identities: [{ channel: 'slack', identifier: 'U012ABCDEG' }] });
    expect(near).toEqual({ taken: [], candidates: [] });
    const exact = await contacts.findLikelyDuplicates({ identities: [{ channel: 'slack', identifier: 'U012ABCDEF' }] });
    expect(exact.taken.map((t) => t.contact.id)).toEqual([priyaId]);
  });

  it('returns nothing for a name-less, identity-less check', async () => {
    expect(await contacts.findLikelyDuplicates({ identities: [] })).toEqual({ taken: [], candidates: [] });
  });
});

describe('agent_stated identities', () => {
  it('are verified on link', async () => {
    const contacts = ContactService.createInMemory();
    const c = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'agent_stated' });
    const identity = await contacts.linkIdentity({
      contactId: c.id, channel: 'email', channelIdentifier: 'dana@newco.example', source: 'agent_stated',
    });
    expect(identity).toMatchObject({ source: 'agent_stated', verified: true });
  });
});
