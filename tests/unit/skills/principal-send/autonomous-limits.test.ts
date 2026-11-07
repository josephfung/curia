import { describe, it, expect } from 'vitest';
import {
  AUTONOMOUS_MAX_RECIPIENTS, AUTONOMOUS_THREAD_COOLDOWN_MS, CURIA_WRITE_SKEW_SEC,
  allowedThreadMembers, checkAutonomousLimits, replyTarget,
} from '../../../../src/skills/principal-send/autonomous-limits.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import type { PrincipalSendEntry } from '../../../../src/skills/principal-send/send-ledger.js';
import type { CuriaDraftWrites } from '../../../../src/skills/principal-send/draft-provenance.js';

const PRINCIPAL = ['ceo@corp.example'];
const VERIFIED = [{ name: 'Authentication-Results', value: 'mx.google.com; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass header.from=x' }];
const WRITE_AT = new Date('2026-11-07T12:00:00.000Z');
const WRITE_SEC = WRITE_AT.getTime() / 1000;

function msg(over: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'm1', threadId: 't1', subject: 'Re: Friday', from: [], to: [], cc: [], bcc: [],
    body: '', snippet: '', date: WRITE_SEC - 3600, unread: false, folders: [], attachments: [],
    ...over,
  };
}

const inboundVerified = msg({ id: 'in1', from: [{ email: 'dana@example.org' }], to: [{ email: 'ceo@corp.example' }], headers: VERIFIED });
const draft = msg({ id: 'd1', date: WRITE_SEC, from: [{ email: 'ceo@corp.example' }], to: [{ email: 'dana@example.org' }] });
const writes: CuriaDraftWrites = { created: true, lastWriteAt: WRITE_AT };

function check(over: Partial<Parameters<typeof checkAutonomousLimits>[0]> = {}) {
  return checkAutonomousLimits({
    draft, thread: [inboundVerified], principalAddresses: PRINCIPAL, curiaWrites: writes, recentThreadEntries: [], ...over,
  });
}

function entry(outcome: PrincipalSendEntry['outcome']): PrincipalSendEntry {
  return { draftId: 'old', threadId: 't1', recipients: ['dana@example.org'], mode: 'autonomous', at: '2026-11-07T00:00:00.000Z', outcome };
}

describe('constants', () => {
  it('match the design', () => {
    expect(AUTONOMOUS_MAX_RECIPIENTS).toBe(5);
    expect(AUTONOMOUS_THREAD_COOLDOWN_MS).toBe(86_400_000);
    expect(CURIA_WRITE_SKEW_SEC).toBe(60);
  });
});

describe('checkAutonomousLimits', () => {
  it('allows a reply to a verified sender', () => {
    expect(check()).toBeNull();
  });

  it('refuses a draft Curia did not create in this task', () => {
    expect(check({ curiaWrites: { created: false, lastWriteAt: null } })?.refusal).toBe('not_curia_draft');
  });

  it('refuses a draft changed after Curia last wrote it', () => {
    expect(check({ draft: { ...draft, date: WRITE_SEC + CURIA_WRITE_SKEW_SEC + 1 } })?.refusal).toBe('draft_changed_since_curia');
    expect(check({ draft: { ...draft, date: WRITE_SEC + CURIA_WRITE_SKEW_SEC } })).toBeNull();
  });

  it('refuses as changed when there is no write time (fail closed)', () => {
    expect(check({ curiaWrites: { created: true, lastWriteAt: null } })?.refusal).toBe('draft_changed_since_curia');
  });

  it('refuses a draft that is not a reply', () => {
    expect(check({ thread: [] })?.refusal).toBe('not_a_reply');
    expect(check({ draft: { ...draft, threadId: '' } })?.refusal).toBe('not_a_reply');
  });

  it('refuses a thread carrying a List-Id header, whatever its case', () => {
    const listed = { ...inboundVerified, headers: [...VERIFIED, { name: 'list-id', value: '<team.lists.example.org>' }] };
    expect(check({ thread: [listed] })?.refusal).toBe('mailing_list');
  });

  it('refuses a recipient not on the thread and names it', () => {
    const r = check({ draft: { ...draft, cc: [{ email: 'mallory@evil.example' }] } });
    expect(r?.refusal).toBe('recipient_not_on_thread');
    expect(r?.detail).toContain('mallory@evil.example');
  });

  it('does not allow an address listed only in an inbound Cc header', () => {
    const forged = { ...inboundVerified, cc: [{ email: 'cfo@corp.example' }] };
    const r = check({ thread: [forged], draft: { ...draft, to: [{ email: 'dana@example.org' }, { email: 'cfo@corp.example' }] } });
    expect(r?.refusal).toBe('recipient_not_on_thread');
    expect(r?.detail).toContain('cfo@corp.example');
  });

  it('allows recipients the principal emailed on the thread', () => {
    const sent = msg({ id: 'out1', from: [{ email: 'ceo@corp.example' }], folders: ['SENT'], to: [{ email: 'bob@example.net' }], cc: [{ email: 'carol@example.net' }], bcc: [{ email: 'eve@example.net' }] });
    expect(check({ thread: [sent], draft: { ...draft, to: [{ email: 'bob@example.net' }], cc: [{ email: 'carol@example.net' }], bcc: [{ email: 'eve@example.net' }] } })).toBeNull();
  });

  it('does not trust a principal From on a message the principal did not send (spoofed inbound)', () => {
    const spoofed = msg({ id: 'in9', from: [{ email: 'ceo@corp.example' }], folders: ['INBOX'], to: [{ email: 'ceo@corp.example' }], cc: [{ email: 'cfo@corp.example' }] });
    const r = check({ thread: [inboundVerified, spoofed], draft: { ...draft, to: [{ email: 'dana@example.org' }, { email: 'cfo@corp.example' }] } });
    expect(r?.refusal).toBe('recipient_not_on_thread');
    expect(r?.detail).toContain('cfo@corp.example');
    expect(allowedThreadMembers([spoofed], PRINCIPAL)).toEqual(new Set(['ceo@corp.example']));
  });

  it('allows the recipients of a genuine SENT message from the principal', () => {
    const sent = msg({ id: 'out2', from: [{ email: 'ceo@corp.example' }], folders: ['SENT'], cc: [{ email: 'cfo@corp.example' }] });
    expect(check({ thread: [inboundVerified, sent], draft: { ...draft, to: [{ email: 'dana@example.org' }, { email: 'cfo@corp.example' }] } })).toBeNull();
  });

  it('does not trust an unverified From', () => {
    const unverified = { ...inboundVerified, headers: [] };
    expect(check({ thread: [unverified] })?.refusal).toBe('recipient_not_on_thread');
    const noHeaders: NylasMessage = { ...inboundVerified };
    delete noHeaders.headers;
    expect(check({ thread: [noHeaders] })?.refusal).toBe('recipient_not_on_thread');
  });

  it('matches thread members case-insensitively', () => {
    expect(check({ draft: { ...draft, to: [{ email: 'Dana@Example.ORG' }] } })).toBeNull();
  });

  it('refuses more than five non-principal recipients', () => {
    const people = Array.from({ length: 6 }, (_, i) => ({ email: `p${i}@example.net` }));
    const sent = msg({ id: 'out1', from: [{ email: 'ceo@corp.example' }], folders: ['SENT'], to: people });
    expect(check({ thread: [sent], draft: { ...draft, to: people } })?.refusal).toBe('too_many_recipients');
    expect(check({ thread: [sent], draft: { ...draft, to: people.slice(0, 5) } })).toBeNull();
  });

  it('does not count the principal toward the recipient cap', () => {
    const people = Array.from({ length: 5 }, (_, i) => ({ email: `p${i}@example.net` }));
    const sent = msg({ id: 'out1', from: [{ email: 'ceo@corp.example' }], folders: ['SENT'], to: people });
    expect(check({ thread: [sent], draft: { ...draft, to: people, cc: [{ email: 'CEO@corp.example' }] } })).toBeNull();
  });

  it('refuses a draft with attachments', () => {
    const att = { id: 'a1', filename: 'x.pdf', contentType: 'application/pdf', size: 10 };
    expect(check({ draft: { ...draft, attachments: [att] } })?.refusal).toBe('has_attachments');
  });

  it('ignores inline attachments (NylasMessage lists only non-inline files)', () => {
    expect(check({ draft: { ...draft, attachments: [] } })).toBeNull();
  });

  it('refuses after any recent entry on the thread, a sending one included', () => {
    expect(check({ recentThreadEntries: [entry('sent')] })?.refusal).toBe('thread_cooldown');
    expect(check({ recentThreadEntries: [entry('held')] })?.refusal).toBe('thread_cooldown');
    // A send that crashed after dispatch stays `sending` and may have gone out (fail closed).
    expect(check({ recentThreadEntries: [entry('sending')] })?.refusal).toBe('thread_cooldown');
  });

  it('checks in the stated order', () => {
    // Not created beats everything else that is also wrong.
    const att = { id: 'a1', filename: 'x.pdf', contentType: 'application/pdf', size: 10 };
    expect(check({
      curiaWrites: { created: false, lastWriteAt: null }, thread: [],
      draft: { ...draft, attachments: [att] }, recentThreadEntries: [entry('sent')],
    })?.refusal).toBe('not_curia_draft');
    // A list beats a stranger recipient.
    const listed = { ...inboundVerified, headers: [...VERIFIED, { name: 'List-Id', value: '<x>' }] };
    expect(check({ thread: [listed], draft: { ...draft, to: [{ email: 'mallory@evil.example' }] } })?.refusal).toBe('mailing_list');
  });
});

describe('allowedThreadMembers', () => {
  it('is principal addresses, what the principal sent to, and verified senders — lowercased', () => {
    const sent = msg({ id: 'out1', from: [{ email: 'CEO@corp.example' }], folders: ['sent'], to: [{ email: 'Bob@Example.net' }] });
    const unverified = msg({ id: 'in2', from: [{ email: 'stranger@example.com' }], cc: [{ email: 'x@example.com' }] });
    expect(allowedThreadMembers([inboundVerified, sent, unverified], PRINCIPAL)).toEqual(
      new Set(['ceo@corp.example', 'dana@example.org', 'bob@example.net']),
    );
  });
});

describe('replyTarget', () => {
  it('is the latest message not from a principal address', () => {
    const older = msg({ id: 'a', from: [{ email: 'dana@example.org' }], date: 100 });
    const newer = msg({ id: 'b', from: [{ email: 'bob@example.net' }], date: 300 });
    const mine = msg({ id: 'c', from: [{ email: 'ceo@corp.example' }], date: 500 });
    expect(replyTarget([newer, mine, older], PRINCIPAL)?.id).toBe('b');
    expect(replyTarget([mine], PRINCIPAL)).toBeNull();
    expect(replyTarget([], PRINCIPAL)).toBeNull();
  });
});
