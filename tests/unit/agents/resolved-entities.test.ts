import { describe, it, expect } from 'vitest';
import {
  collectResolvedContactIds,
  describeUnresolvedIdentity,
  emailLocalNameTokens,
  formatResolvedEntitiesBlock,
  parseResolvedContactIds,
  type ResolvedEntityCard,
} from '../../../src/agents/resolved-entities.js';

const XIAOPU = '11111111-1111-4111-8111-111111111111';
const JOSEPH = '22222222-2222-4222-8222-222222222222';

function card(over: Partial<ResolvedEntityCard> & Pick<ResolvedEntityCard, 'contactId' | 'displayName'>): ResolvedEntityCard {
  return {
    preferredName: null,
    role: null,
    organization: null,
    primaryEmail: null,
    primaryPhone: null,
    ...over,
  };
}

describe('parseResolvedContactIds', () => {
  it('reads contact ids from a resolved_entities block and ignores other text', () => {
    const text = `
      See also id="99999999-9999-4999-8999-999999999999" outside the block.
      <resolved_entities>
        <contact role="Spouse" name="Xiaopu Fung" id="${XIAOPU}"/>
        <contact id='${JOSEPH}' name="Joseph Fung"/>
      </resolved_entities>
    `;
    expect(parseResolvedContactIds(text)).toEqual([XIAOPU, JOSEPH]);
  });

  it('drops non-uuid ids and duplicates', () => {
    const text = `
      <resolved_entities>
        <contact name="Nope" id="abc-123"/>
        <contact name="Xiaopu Fung" id="${XIAOPU}"/>
        <contact name="Xiaopu Fung" id="${XIAOPU.toUpperCase()}"/>
      </resolved_entities>
    `;
    expect(parseResolvedContactIds(text)).toEqual([XIAOPU]);
  });
});

describe('collectResolvedContactIds', () => {
  it('reads the structured field that survives tag stripping', () => {
    const data = {
      response: 'Xiaopu Fung is on file.',
      agent: 'contacts',
      resolvedContactIds: [XIAOPU, 'not-a-uuid', XIAOPU],
    };
    expect(collectResolvedContactIds(data)).toEqual([XIAOPU]);
  });

  it('still parses markup when the execution layer has not stripped it', () => {
    expect(collectResolvedContactIds({
      response: `<resolved_entities><contact id="${XIAOPU}" name="Xiaopu Fung"/></resolved_entities>`,
    })).toEqual([XIAOPU]);
  });
});

describe('formatResolvedEntitiesBlock', () => {
  it('renders the current card, not a caller-supplied snapshot', () => {
    const block = formatResolvedEntitiesBlock([
      card({
        contactId: XIAOPU,
        displayName: 'Xiaopu Chen',
        role: 'Spouse',
        primaryEmail: 'xiaopu@example.com',
      }),
    ]);
    expect(block).toContain('name="Xiaopu Chen"');
    expect(block).toContain(`id="${XIAOPU}"`);
    expect(block).toContain('email="xiaopu@example.com"');
    expect(block).toContain('not kept in conversation history');
    expect(block).not.toContain('Xiaopu Fung');
  });

  it('escapes attribute values and drops oldest cards past the character cap', () => {
    const cards = [
      card({ contactId: XIAOPU, displayName: 'Xiaopu "Chen" <admin>' }),
      card({ contactId: JOSEPH, displayName: 'Joseph Fung' }),
    ];
    const firstOnly = formatResolvedEntitiesBlock([cards[0]!]);
    expect(firstOnly).toBeTruthy();
    const tight = formatResolvedEntitiesBlock(cards, firstOnly!.length);
    expect(tight).toContain('&quot;');
    expect(tight).toContain('&lt;admin&gt;');
    expect(tight).toContain(XIAOPU);
    expect(tight).not.toContain(JOSEPH);
  });

  it('returns null when there is nothing to inject', () => {
    expect(formatResolvedEntitiesBlock([])).toBeNull();
  });
});

describe('describeUnresolvedIdentity', () => {
  const covered = ['Joseph Fung', 'Xiaopu Chen'];

  it('allows a full name that was resolved this turn, and the principal', () => {
    const body = 'He and Xiaopu Chen would like to attend.\n- Joseph Fung — joseph@example.com\n- Xiaopu Chen';
    expect(describeUnresolvedIdentity(body, covered)).toBeNull();
  });

  it('blocks a first name that is not resolved, and an explicit unconfirmed surname', () => {
    const body = 'He and Xiaopu (last name to be confirmed) would like to attend.\n- Xiaopu (Joseph\'s guest)';
    const reason = describeUnresolvedIdentity(body, ['Joseph Fung']);
    expect(reason).toContain('Xiaopu');
    expect(reason).toContain('not resolved');
    expect(reason).toContain('unconfirmed');
  });

  it('blocks a partial-identity hedge even when the first name matches a resolved contact', () => {
    const body = 'Xiaopu Chen (last name to be confirmed) will attend.';
    const reason = describeUnresolvedIdentity(body, covered);
    expect(reason).toContain('unconfirmed');
    expect(reason).not.toContain('not resolved');
  });

  it('ignores greetings, weekdays, places, and the recipient email local part', () => {
    expect(describeUnresolvedIdentity('Hi there,\nSee you Monday in New York.', covered)).toBeNull();
    expect(describeUnresolvedIdentity('Hello Dani, confirming two seats.', ['dani'])).toBeNull();
    expect(emailLocalNameTokens('dani@wrcf.ca')).toEqual(['dani']);
    expect(emailLocalNameTokens('no-reply@wrcf.ca')).toEqual([]);
  });

  it('does not join a name across a newline or block a title-case subject', () => {
    const coveredPeople = ['Dani', 'Xiaopu Chen', 'Joseph Fung'];
    expect(describeUnresolvedIdentity(
      'Hi Dani,\n\nXiaopu Chen will attend.\n\nJoseph Fung\nCurious Minds Inc.',
      coveredPeople,
    )).toBeNull();
    expect(describeUnresolvedIdentity(
      'Hi Dani,\n\nXiaopu Chen\nDani will attend.\n\nJoseph Fung\nCurious Minds Inc.',
      coveredPeople,
    )).toBeNull();
    expect(describeUnresolvedIdentity(
      'Quarterly Planning Session\nI have shared the deck on Google Drive.',
      [],
    )).toBeNull();
    expect(describeUnresolvedIdentity({
      subject: 'Quarterly Planning Session',
      body: 'I have shared the deck on Google Drive.',
    }, [])).toBeNull();
    expect(describeUnresolvedIdentity({
      subject: 'Xiaopu (last name to be confirmed)',
      body: 'See you there.',
    }, [])).toContain('unconfirmed');
  });

  it('treats an uncovered CJK or accented name as unresolved, and the full name as covered', () => {
    const cjk = describeUnresolvedIdentity('李伟 would like to attend.', []);
    expect(cjk).toContain('李伟');
    expect(describeUnresolvedIdentity('李伟 would like to attend.', ['李伟'])).toBeNull();

    const accented = describeUnresolvedIdentity('José Müller would like to attend.', []);
    expect(accented).toContain('José Müller');
    expect(accented).not.toContain('"Jos"');
    expect(describeUnresolvedIdentity('José Müller would like to attend.', ['José Müller'])).toBeNull();
  });

  it('treats an honorific as a person cue even though it overlaps the name', () => {
    const uncovered = describeUnresolvedIdentity('Please add Mr Marcus Webb to the list.', []);
    expect(uncovered).toContain('Marcus Webb');
    expect(describeUnresolvedIdentity('Please add Mr Marcus Webb to the list.', ['Marcus Webb'])).toBeNull();
    expect(describeUnresolvedIdentity('Dr Priya Raman will be joining us.', [])).toContain('Priya Raman');
    expect(describeUnresolvedIdentity('Mrs Webb confirmed.', ['Webb'])).toBeNull();
  });

  it('does not treat a capitalized cue header as an unresolved person', () => {
    const covered = ['Joseph Fung', 'Xiaopu Chen'];
    expect(describeUnresolvedIdentity('Attendees:\n- Joseph Fung\n- Xiaopu Chen', covered)).toBeNull();
    expect(describeUnresolvedIdentity('Guests:\n- Joseph Fung\n- Xiaopu Chen', covered)).toBeNull();
    expect(describeUnresolvedIdentity('Invited:\n- Joseph Fung', ['Joseph Fung'])).toBeNull();
    expect(describeUnresolvedIdentity('Attendees:\n- Marcus Webb', covered)).toContain('Marcus Webb');
  });

  it('does not block an unresolved name that has no invitation or attendance cue', () => {
    // Deliberate. The gate is hedges plus a nearby cue, not every proper name.
    const covered = ['Joseph Fung', 'Dani Smith', 'Xiaopu Chen'];
    expect(describeUnresolvedIdentity(
      'I am connecting you with Marcus Webb about the contract.',
      covered,
    )).toBeNull();
  });

  it('flags a two-letter name when a person cue is nearby', () => {
    expect(describeUnresolvedIdentity('Al Li would like to attend.', [])).toContain('Al Li');
    expect(describeUnresolvedIdentity('Al Li would like to attend.', ['Al Li'])).toBeNull();
  });

  it('slices attribute text before escaping so an ampersand is not cut mid-entity', () => {
    const displayName = `${'A'.repeat(119)}&more`;
    const block = formatResolvedEntitiesBlock([
      card({ contactId: XIAOPU, displayName }),
    ]);
    expect(block).toContain(`${'A'.repeat(119)}&amp;`);
    expect(block).not.toContain('&more');
    expect(block).not.toMatch(/&(?!amp;|quot;|lt;|gt;)/);
  });
});
