import { describe, it, expect } from 'vitest';
import { audienceMetadataOf, frozenAudienceMetadataOf, isOneToOneAudience } from '../../../src/dispatch/audience.js';
import { contactRecentHistoryAudienceIsPrivate } from '../../../src/memory/contact-recent-history.js';

const SELF = ['curia@example.com'];

describe('isOneToOneAudience', () => {
  it('signal dm true, group false', () => {
    expect(isOneToOneAudience('signal', 'signal:+15551234567', undefined, SELF)).toBe(true);
    expect(isOneToOneAudience('signal', 'signal:group=abc', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('signal', 'other:+1555', undefined, SELF)).toBe(false);
  });

  it('slack dm true, channel false', () => {
    expect(isOneToOneAudience('slack', 'slack:D123', undefined, SELF)).toBe(true);
    expect(isOneToOneAudience('slack', 'slack:C123:1700000000.000100', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('slack', 'not-slack', undefined, SELF)).toBe(false);
  });

  it('sms true', () => {
    expect(isOneToOneAudience('sms', 'sms:+15551234567', undefined, SELF)).toBe(true);
  });

  it('email from principal to curia only is one-to-one', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [
        { email: 'Boss@Example.com', role: 'from' },
        { email: ' curia@example.com ', role: 'to' },
      ],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, SELF)).toBe(true);
  });

  it('email with a cc\'d third party is not', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [
        { email: 'boss@example.com', role: 'from' },
        { email: 'curia@example.com', role: 'to' },
        { email: 'other@example.com', role: 'cc' },
      ],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, SELF)).toBe(false);
  });

  it('email with only the sender (Curia BCC\'d) is not', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [{ email: 'boss@example.com', role: 'from' }],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, SELF)).toBe(false);
  });

  it('email with no selfEmails is not', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [
        { email: 'boss@example.com', role: 'from' },
        { email: 'curia@example.com', role: 'to' },
      ],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, [])).toBe(false);
  });

  it('email with no participants is not', () => {
    expect(isOneToOneAudience('email', 'email:t1', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('email', 'email:t1', { participants: [] }, SELF)).toBe(false);
    expect(isOneToOneAudience('email', 'email:t1', { participants: [null, 'x', { role: 'to' }] }, SELF)).toBe(false);
  });

  it('web and cli, principal-only surfaces, are one-to-one', () => {
    expect(isOneToOneAudience('web', 'web:thread-1', undefined, SELF)).toBe(true);
    expect(isOneToOneAudience('cli', 'cli:local:default', undefined, SELF)).toBe(true);
  });

  it('voice and unknown channels are not', () => {
    expect(isOneToOneAudience('voice', 'voice:1', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('http', 'http:1', undefined, SELF)).toBe(false);
  });
});

describe('audienceMetadataOf (#2588 recovery turns)', () => {
  const twoParty = [{ email: 'boss@example.com', role: 'from', name: 'Boss' }, { email: 'curia@example.com', role: 'to' }];
  // Every shape the rule accepts or rejects, varied one field at a time.
  const cases: Record<string, unknown>[] = [
    { curiaRole: 'to', primaryRecipientEmails: [], participants: twoParty },
    { curiaRole: 'cc', primaryRecipientEmails: [], participants: twoParty },
    { curiaRole: 'to', primaryRecipientEmails: ['x@example.com'], participants: twoParty },
    { curiaRole: 'to', primaryRecipientEmails: [{ email: 'x@example.com' }], participants: twoParty },
    { curiaRole: 'to', primaryRecipientEmails: 'nope', participants: twoParty },
    { curiaRole: 'to', participants: twoParty },
    { curiaRole: 'to', primaryRecipientEmails: [], participants: [...twoParty, { email: 'o@example.com', role: 'cc' }] },
    { curiaRole: 'to', primaryRecipientEmails: [], participants: [twoParty[0], { email: 'curia@example.com', role: 'bcc' }] },
    { curiaRole: 'to', primaryRecipientEmails: [], participants: [twoParty[0], { email: 42, role: 'to' }] },
    { curiaRole: 'to', primaryRecipientEmails: [], participants: [null, 'x', { role: 'to' }] },
    { curiaRole: 'to', primaryRecipientEmails: [], participants: [twoParty[0], ['curia@example.com']] },
    { curiaRole: 'to', primaryRecipientEmails: [], participants: { 0: twoParty[0] } },
    { curiaRole: 'to', primaryRecipientEmails: [], participants: [] },
    { curiaRole: 1, primaryRecipientEmails: [], participants: twoParty },
    { primaryRecipientEmails: [], participants: twoParty },
    {},
  ];

  it('the copy judges every case as the original does, for both rules that read it', () => {
    for (const metadata of cases) {
      const copy = audienceMetadataOf(metadata) ?? undefined;
      expect(isOneToOneAudience('email', 'email:t1', copy, SELF)).toBe(isOneToOneAudience('email', 'email:t1', metadata, SELF));
      expect(contactRecentHistoryAudienceIsPrivate({ channelId: 'email', conversationId: 'email:t1', metadata: copy, selfEmails: SELF }))
        .toBe(contactRecentHistoryAudienceIsPrivate({ channelId: 'email', conversationId: 'email:t1', metadata, selfEmails: SELF }));
    }
    // The first case is the one-to-one one, so the loop covers both answers.
    expect(isOneToOneAudience('email', 'email:t1', audienceMetadataOf(cases[0]!) ?? undefined, SELF)).toBe(true);
  });

  it('copies only the audience inputs, and only email and role of a participant', () => {
    const copy = audienceMetadataOf({ curiaRole: 'to', primaryRecipientEmails: [], participants: twoParty, nylasThreadId: 't', originator: {} });
    expect(copy).toEqual({
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [{ email: 'boss@example.com', role: 'from' }, { email: 'curia@example.com', role: 'to' }],
    });
    expect(audienceMetadataOf({ nylasThreadId: 't' })).toBeNull();
    expect(audienceMetadataOf(undefined)).toBeNull();
  });

  it('the frozen form leaves the source alone and cannot be changed', () => {
    const source = { curiaRole: 'to', primaryRecipientEmails: [], participants: twoParty.map((p) => ({ ...p })) };
    const frozen = frozenAudienceMetadataOf(source)!;
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen['participants'])).toBe(true);
    expect(Object.isFrozen((frozen['participants'] as object[])[0])).toBe(true);
    expect(Object.isFrozen(source.participants[0])).toBe(false);
    // A fresh copy of the frozen form is writable again.
    const fresh = audienceMetadataOf(frozen)!;
    expect(Object.isFrozen(fresh['participants'])).toBe(false);
  });
});
