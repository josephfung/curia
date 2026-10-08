// Duplicate check before an agent records a cold-outreach address (#2041).

import { describe, it, expect } from 'vitest';
import {
  matchOutreachDuplicates,
  outreachDuplicateError,
  type IdentitySummary,
  type NameSummary,
} from '../../../src/contacts/outreach-duplicates.js';

const PRIYA = '11111111-1111-4111-8111-111111111111';
const JENNA = '22222222-2222-4222-8222-222222222222';
const PAT = '33333333-3333-4333-8333-333333333333';

function email(contactId: string, displayName: string, channelIdentifier: string): IdentitySummary {
  return { contactId, displayName, channel: 'email', channelIdentifier };
}

function phone(contactId: string, displayName: string, channelIdentifier: string, channel = 'phone'): IdentitySummary {
  return { contactId, displayName, channel, channelIdentifier };
}

function names(...rows: NameSummary[]): NameSummary[] {
  return rows;
}

describe('matchOutreachDuplicates', () => {
  it('is empty when the name is unique and no identifier is proposed', () => {
    const report = matchOutreachDuplicates({
      displayName: 'Dana Cho',
      identifiers: [],
      identities: [email(PRIYA, 'Priya Natarajan', 'priya@example.test')],
      names: names({ contactId: PRIYA, displayName: 'Priya Natarajan' }),
    });
    expect(report).toEqual({ exact: [], likely: [] });
  });

  it('matches an email exactly, case-insensitively', () => {
    const report = matchOutreachDuplicates({
      displayName: 'Someone Else',
      identifiers: [{ channel: 'email', identifier: 'Priya@Example.TEST' }],
      identities: [email(PRIYA, 'Priya Natarajan', 'priya@example.test')],
      names: names({ contactId: PRIYA, displayName: 'Priya Natarajan' }),
    });
    expect(report.exact).toEqual([
      { contactId: PRIYA, displayName: 'Priya Natarajan', kind: 'same_address', channel: 'email' },
    ]);
    expect(report.likely).toEqual([]);
  });

  it('flags a TLD swap and an inserted dot, and not two unrelated addresses', () => {
    const identities = [
      email(PRIYA, 'Priya Natarajan', 'first@firstlast.ca'),
      email(JENNA, 'Jenna Torres', 'jenna@work.com'),
      email(PAT, 'Pat Home', 'pat@acme.com'),
    ];
    const dotted = matchOutreachDuplicates({
      identifiers: [{ channel: 'email', identifier: 'first@first.last.ca' }],
      identities,
      names: [],
    });
    expect(dotted.likely.map((hit) => hit.contactId)).toEqual([PRIYA]);
    expect(dotted.exact).toEqual([]);

    const tld = matchOutreachDuplicates({
      identifiers: [{ channel: 'email', identifier: 'first@firstlast.com' }],
      identities,
      names: [],
    });
    expect(tld.likely.map((hit) => hit.contactId)).toEqual([PRIYA]);

    const unrelated = matchOutreachDuplicates({
      identifiers: [{ channel: 'email', identifier: 'sam@other.org' }],
      identities,
      names: [],
    });
    expect(unrelated).toEqual({ exact: [], likely: [] });
  });

  it('does not treat work and personal addresses for the same local part as a near-miss', () => {
    const report = matchOutreachDuplicates({
      identifiers: [{ channel: 'email', identifier: 'jenna@personal.com' }],
      identities: [email(JENNA, 'Jenna Torres', 'jenna@work.com')],
      names: [],
    });
    expect(report).toEqual({ exact: [], likely: [] });
  });

  it('flags a one-digit phone change and not the spouse numbers from #727', () => {
    const identities = [
      phone(PAT, 'Pat', '+15196161377'),
      phone(PRIYA, 'Spouse', '+15195040098', 'signal'),
    ];
    const oneDigit = matchOutreachDuplicates({
      identifiers: [{ channel: 'phone', identifier: '+15196161378' }],
      identities,
      names: [],
    });
    expect(oneDigit.likely.map((hit) => hit.contactId)).toEqual([PAT]);

    const spouse = matchOutreachDuplicates({
      identifiers: [{ channel: 'signal', identifier: '+15196161377' }],
      identities,
      names: [],
    });
    expect(spouse).toEqual({ exact: [], likely: [] });
  });

  it('flags an exact name and a one-letter name typo, and not John versus Jane', () => {
    const people = names(
      { contactId: PRIYA, displayName: 'Priya Natarajan' },
      { contactId: PAT, displayName: 'John Smith' },
    );
    const exact = matchOutreachDuplicates({
      displayName: 'Priya Natarajan',
      identifiers: [],
      identities: [],
      names: people,
    });
    expect(exact.likely.map((hit) => hit.kind)).toEqual(['similar_name']);

    const typo = matchOutreachDuplicates({
      displayName: 'Priya Natrajan',
      identifiers: [],
      identities: [],
      names: people,
    });
    expect(typo.likely.map((hit) => hit.contactId)).toEqual([PRIYA]);

    const jane = matchOutreachDuplicates({
      displayName: 'Jane Smith',
      identifiers: [],
      identities: [],
      names: people,
    });
    expect(jane).toEqual({ exact: [], likely: [] });
  });

  it('does not report the contact being updated', () => {
    const report = matchOutreachDuplicates({
      identifiers: [{ channel: 'email', identifier: 'pat@home.exampl' }],
      identities: [email(PAT, 'Pat', 'pat@home.example')],
      names: names({ contactId: PAT, displayName: 'Pat' }),
      excludeContactId: PAT,
    });
    expect(report).toEqual({ exact: [], likely: [] });
  });

  it('prefers an exact address over a similar name for the same contact', () => {
    const report = matchOutreachDuplicates({
      displayName: 'Priya Natarajan',
      identifiers: [{ channel: 'email', identifier: 'priya@example.test' }],
      identities: [email(PRIYA, 'Priya Natarajan', 'priya@example.test')],
      names: names({ contactId: PRIYA, displayName: 'Priya Natarajan' }),
    });
    expect(report.exact).toHaveLength(1);
    expect(report.likely).toEqual([]);
  });
});

describe('outreachDuplicateError', () => {
  const priya = { contactId: PRIYA, displayName: 'Priya Natarajan' };

  it('names the contact and not the address, and confirm_new does not cover an exact match', () => {
    const error = outreachDuplicateError({
      exact: [{ ...priya, kind: 'same_address', channel: 'email' }],
      likely: [],
    }, 'created');
    expect(error).toContain(PRIYA);
    expect(error).toContain('Priya Natarajan');
    expect(error).toMatch(/confirm_new does not apply/);
    expect(error).not.toMatch(/@/);
  });

  it('tells the agent to pass confirm_new for a near-miss', () => {
    const error = outreachDuplicateError({
      exact: [],
      likely: [{ ...priya, kind: 'similar_name' }],
    }, 'linked');
    expect(error).toMatch(/confirm_new true/);
    expect(error).toMatch(/Nothing was linked/);
    expect(error).not.toMatch(/@/);
  });
});
