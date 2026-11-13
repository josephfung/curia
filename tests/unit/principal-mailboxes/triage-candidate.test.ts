import { describe, expect, it } from 'vitest';
import { isTriageCandidate, unreadCandidateProbe } from '../../../src/principal-mailboxes/triage-candidate.js';

const base = { unread: true, folders: ['INBOX', 'UNREAD'], from: [{ email: 'ann@example.com' }], date: 1_000 };
const curia = new Set(['curia@example.org']);

describe('isTriageCandidate', () => {
  it('keeps unread INBOX mail from someone else', () => {
    expect(isTriageCandidate(base, curia)).toBe(true);
  });

  it("drops Curia's own mail, whatever the case of the address", () => {
    expect(isTriageCandidate({ ...base, from: [{ email: 'Curia@Example.org' }] }, curia)).toBe(false);
  });

  it('drops read mail and mail outside INBOX', () => {
    expect(isTriageCandidate({ ...base, unread: false }, curia)).toBe(false);
    expect(isTriageCandidate({ ...base, folders: ['SENT'] }, curia)).toBe(false);
  });

  it('drops mail before the start line, keeps mail at it', () => {
    expect(isTriageCandidate(base, curia, 1_001)).toBe(false);
    expect(isTriageCandidate(base, curia, 1_000)).toBe(true);
  });
});

describe('unreadCandidateProbe (BR-I3)', () => {
  const probeOver = (messages: Array<typeof base>) => {
    const listMessages = async (o: Record<string, unknown>) => { calls.push(o); return messages; };
    const calls: Array<Record<string, unknown>> = [];
    const probe = unreadCandidateProbe({ client: async () => ({ listMessages }), curiaEmails: async () => curia });
    return { probe, calls };
  };

  it('a mailbox whose only unread mail is from Curia stays quiet', async () => {
    const { probe } = probeOver([{ ...base, from: [{ email: 'curia@example.org' }] }]);
    expect(await probe('work', null)).toBe(false);
  });

  it('finds real mail behind Curia\'s own, and sends the start line', async () => {
    const { probe, calls } = probeOver([{ ...base, from: [{ email: 'curia@example.org' }] }, { ...base, date: 5_000 }]);
    expect(await probe('work', new Date(2_000_000))).toBe(true);
    expect(calls[0]).toMatchObject({ unread: true, folders: ['INBOX'], limit: 10, receivedAfter: 2_000 });
  });
});
