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

  // A name typo is a candidate, never blocking: the agent can still name the contact in
  // distinct_from. The threshold is NAME_NEAR_MISS_THRESHOLD (Jaro-Winkler on the
  // normalized names), set between the pairs below.
  describe('near-miss display names', () => {
    it('reports a one-letter typo as similar_name', async () => {
      const check = await contacts.findLikelyDuplicates({ displayName: 'Priya Natrajan', identities: [] });
      expect(check.taken).toEqual([]);
      expect(check.candidates).toEqual([
        { contact: expect.objectContaining({ id: priyaId }), reasons: [{ kind: 'similar_name' }] },
      ]);
    });

    it.each([
      ['Jenna Torres', 'Jena Torres'],
      ["Michael O'Connor", "Micheal O'Connor"],
      ['Jose Garcia', 'José Garcia'],
    ])('reports %s / %s as similar_name', async (stored, typed) => {
      const other = await contacts.createContact({ displayName: stored, source: 'ceo_stated' });
      const check = await contacts.findLikelyDuplicates({ displayName: typed, identities: [] });
      expect(check.candidates).toEqual([
        { contact: expect.objectContaining({ id: other.id }), reasons: [{ kind: 'similar_name' }] },
      ]);
    });

    it.each([
      ['Sarah Johnson', 'Sarah Jones'],
      ['David Kim', 'David King'],
      ['Alex Morgan', 'Alex Martin'],
      ['Pat Principal', 'Sam Principal'],
    ])('does not report %s / %s: different people with one shared name', async (stored, typed) => {
      await contacts.createContact({ displayName: stored, source: 'ceo_stated' });
      const check = await contacts.findLikelyDuplicates({ displayName: typed, identities: [] });
      expect(check).toEqual({ taken: [], candidates: [] });
    });

    it('reports an exact match as same_name only, not also similar_name', async () => {
      const check = await contacts.findLikelyDuplicates({ displayName: 'Priya Natarajan', identities: [] });
      expect(check.candidates).toHaveLength(1);
      expect(check.candidates[0]!.reasons).toEqual([{ kind: 'same_name' }]);
    });

    it('never reports the contact being added to', async () => {
      const check = await contacts.findLikelyDuplicates({
        displayName: 'Priya Natrajan',
        identities: [],
        excludeContactId: priyaId,
      });
      expect(check).toEqual({ taken: [], candidates: [] });
    });

    it('adds the name to an identity reason on the same contact', async () => {
      const check = await contacts.findLikelyDuplicates({
        displayName: 'Priya Natrajan',
        identities: [{ channel: 'email', identifier: 'priya@exmaple.test' }],
      });
      expect(check.candidates).toHaveLength(1);
      expect(check.candidates[0]!.reasons).toEqual([
        { kind: 'similar_address', channel: 'email' },
        { kind: 'similar_name' },
      ]);
    });

    it('finds a typo among many contacts, none skipped', async () => {
      for (let i = 0; i < 300; i++) {
        await contacts.createContact({ displayName: `Filler Person ${i}`, source: 'ceo_stated' });
      }
      const target = await contacts.createContact({ displayName: 'Zoltan Kovacs', source: 'ceo_stated' });
      const check = await contacts.findLikelyDuplicates({ displayName: 'Zoltan Kovachs', identities: [] });
      expect(check.candidates.map((c) => c.contact.id)).toEqual([target.id]);
    });
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

// An agent typed these identifiers, so they are verified only when the writer found them
// in a source and says so (#2061). A writer that does not check stores them unverified.
describe('agent-entered identities', () => {
  it.each(['agent_stated', 'agent_called'] as const)('%s is unverified unless the writer verifies it', async (source) => {
    const contacts = ContactService.createInMemory();
    const c = await contacts.createContact({ displayName: 'Dana Whitfield', source });
    const unchecked = await contacts.linkIdentity({
      contactId: c.id, channel: 'email', channelIdentifier: 'dana@newco.example', source,
    });
    expect(unchecked).toMatchObject({ source, verified: false });
    const checked = await contacts.linkIdentity({
      contactId: c.id, channel: 'email', channelIdentifier: 'dana@other.example', source, verified: true,
    });
    expect(checked).toMatchObject({ source, verified: true });
  });
});
