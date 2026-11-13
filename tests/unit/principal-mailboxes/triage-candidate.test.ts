import { describe, expect, it, vi } from 'vitest';
import { isTriageCandidate, PROBE_MAX_PAGES, unreadCandidateProbe } from '../../../src/principal-mailboxes/triage-candidate.js';

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

describe('unreadCandidateProbe (BR-I3, R71)', () => {
  type Page = { messages: Array<typeof base>; nextCursor?: string };
  const probeOver = (pages: Page[]) => {
    const calls: Array<Record<string, unknown>> = [];
    const warn = vi.fn();
    const listUnreadInboxPage = async (o: Record<string, unknown>) => {
      calls.push(o);
      return pages[calls.length - 1] ?? { messages: [] };
    };
    const probe = unreadCandidateProbe({ client: async () => ({ listUnreadInboxPage }), curiaEmails: async () => curia, logger: { warn } });
    return { probe, calls, warn };
  };
  const spoofed = (n: number) => Array.from({ length: n }, () => ({ ...base, from: [{ email: 'curia@example.org' }] }));

  it('a mailbox whose only unread mail is from Curia stays quiet', async () => {
    const { probe } = probeOver([{ messages: spoofed(1) }]);
    expect(await probe('work', null)).toBe(false);
  });

  it('sends the start line and stops at the first real message', async () => {
    const { probe, calls } = probeOver([{ messages: [{ ...base, date: 5_000 }], nextCursor: 'c2' }]);
    expect(await probe('work', new Date(2_000_000))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ limit: 10, receivedAfter: 2_000 });
  });

  it('pages past a full page of spoofed Curia mail to a real message on page 2, and warns once a day', async () => {
    const t = probeOver([{ messages: spoofed(10), nextCursor: 'c2' }, { messages: [base] }, { messages: spoofed(10), nextCursor: 'c2' }, { messages: [base] }]);
    expect(await t.probe('work', null)).toBe(true);
    expect(t.calls[1]).toMatchObject({ pageToken: 'c2' });
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(await t.probe('work', null)).toBe(true);
    expect(t.warn).toHaveBeenCalledTimes(1);
  });

  it('fails open when the page bound is hit with only filtered mail', async () => {
    const pages = Array.from({ length: PROBE_MAX_PAGES + 2 }, (_, i) => ({ messages: spoofed(10), nextCursor: `c${i + 2}` }));
    const t = probeOver(pages);
    expect(await t.probe('work', null)).toBe(true);
    expect(t.calls).toHaveLength(PROBE_MAX_PAGES);
    expect(t.warn).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'work', pages: PROBE_MAX_PAGES }), expect.any(String));
  });
});
