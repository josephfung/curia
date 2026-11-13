import { describe, it, expect, vi } from 'vitest';
import { ACCOUNT_NOT_IN_DOUBT, chosenAccountFields, mailboxEvidence, classifyEvidence, type MailboxEvidence } from '../../../src/principal-mailboxes/evidence.js';
import { mailboxView, stubPrincipalMailboxes } from '../../../skills/_shared/principal-mailboxes-test-helpers.js';

function ev(id: string, over: Partial<MailboxEvidence> = {}): MailboxEvidence {
  return { mailbox: id, mailbox_label: id, sent_count: 0, last_sent_at: null, recent_subjects: [], received_count: 0, domain_match: false, ...over };
}

describe('classifyEvidence', () => {
  it('agrees when the chosen mailbox leads and the others have nothing', () => {
    expect(classifyEvidence([ev('work', { sent_count: 2 }), ev('personal')], 'work')).toBe('agrees');
  });
  it('leans_other when another mailbox scores higher', () => {
    expect(classifyEvidence([ev('work'), ev('personal', { received_count: 1 })], 'work')).toBe('leans_other');
  });
  it('none when no mailbox has any evidence', () => {
    expect(classifyEvidence([ev('work'), ev('personal')], 'work')).toBe('none');
  });
  it('split when both have evidence and the chosen is not strictly alone', () => {
    expect(classifyEvidence([ev('work', { sent_count: 1 }), ev('personal', { sent_count: 1 })], 'work')).toBe('split');
  });
  it('weights a domain match as 5', () => {
    expect(classifyEvidence([ev('work', { domain_match: true }), ev('personal', { sent_count: 2 })], 'work')).toBe('split');
    expect(classifyEvidence([ev('work', { domain_match: true }), ev('personal', { sent_count: 3 })], 'work')).toBe('leans_other');
  });
});

describe('unreadable accounts', () => {
  it('an errored account turns agrees or none into split', () => {
    expect(classifyEvidence([ev('work', { sent_count: 2 }), ev('personal', { error: 'HTTP 500' })], 'work')).toBe('split');
    expect(classifyEvidence([ev('work'), ev('personal', { error: 'HTTP 500' })], 'work')).toBe('split');
  });
  it('never leans away from a chosen account that errored', () => {
    expect(classifyEvidence([ev('work', { error: 'HTTP 500' }), ev('personal', { sent_count: 3 })], 'work')).toBe('split');
  });
});

const FOLDERS = [
  { id: 'SENT', name: 'Sent', attributes: ['\\Sent'] },
  { id: 'INBOX', name: 'Inbox', attributes: ['\\Inbox'] },
];

function msg(id: string, date: number, over: Record<string, unknown> = {}) {
  return { id, threadId: `t${id}`, subject: `subj ${id}`, from: [{ email: 'me@x.example.com' }], to: [], cc: [], bcc: [], body: '', snippet: '', date, unread: false, folders: [], attachments: [], ...over };
}

function fakeClient(sent: unknown[], inbox: unknown[], fail?: Error) {
  return {
    listFolders: async () => {
      if (fail) throw fail;
      return FOLDERS;
    },
    listMessages: async (o: { folders: string[] }) => (o.folders[0] === 'SENT' ? sent : inbox),
  };
}

describe('mailboxEvidence', () => {
  const mailboxes = [
    mailboxView('work', 'Work', 'ceo@acme.example.com', true),
    mailboxView('personal', 'Personal', 'me@gmail.com'),
  ];

  it('counts sent to and received from the recipient, per mailbox', async () => {
    const svc = stubPrincipalMailboxes({
      mailboxes,
      gatewayClients: {
        work: fakeClient(
          [msg('1', 1000, { to: [{ email: 'Bob@Acme.example.com' }] }), msg('2', 2000, { cc: [{ email: 'bob@acme.example.com' }] }), msg('x', 3000, { to: [{ email: 'other@example.org' }] })],
          [msg('3', 1500, { from: [{ email: 'bob@acme.example.com' }] })],
        ),
        personal: fakeClient([], []),
      },
    });
    const out = await mailboxEvidence(svc, ['bob@acme.example.com']);
    const work = out.find((e) => e.mailbox === 'work')!;
    expect(work).toMatchObject({ sent_count: 2, received_count: 1, domain_match: true, recent_subjects: ['subj 2', 'subj 1'] });
    expect(work.last_sent_at).toBe(new Date(2000 * 1000).toISOString());
    expect(out.find((e) => e.mailbox === 'personal')).toMatchObject({ sent_count: 0, received_count: 0, domain_match: false });
  });

  it('does not count a shared consumer domain as a match', async () => {
    const svc = stubPrincipalMailboxes({ mailboxes, gatewayClients: { work: fakeClient([], []), personal: fakeClient([], []) } });
    const out = await mailboxEvidence(svc, ['friend@gmail.com']);
    expect(out.find((e) => e.mailbox === 'personal')!.domain_match).toBe(false);
  });

  it('does not count another public provider as a domain match', async () => {
    const svc = stubPrincipalMailboxes({
      mailboxes: [mailboxView('work', 'Work', 'ceo@acme.example.com', true), mailboxView('personal', 'Personal', 'me@outlook.com')],
      gatewayClients: { work: fakeClient([], []), personal: fakeClient([], []) },
    });
    const out = await mailboxEvidence(svc, ['friend@outlook.com']);
    expect(out.find((e) => e.mailbox === 'personal')!.domain_match).toBe(false);
  });

  it('counts a message the principal sent to the recipient in bcc', async () => {
    const svc = stubPrincipalMailboxes({
      mailboxes,
      gatewayClients: {
        work: fakeClient([msg('1', 1000, { bcc: [{ email: 'bob@acme.example.com' }] })], []),
        personal: fakeClient([], []),
      },
    });
    const out = await mailboxEvidence(svc, ['bob@acme.example.com']);
    expect(out.find((e) => e.mailbox === 'work')).toMatchObject({ sent_count: 1, recent_subjects: ['subj 1'] });
  });

  it('reports a failing mailbox with a class only and still computes the others', async () => {
    const svc = stubPrincipalMailboxes({
      mailboxes,
      gatewayClients: {
        work: fakeClient([msg('1', 1000, { to: [{ email: 'bob@acme.example.com' }] })], []),
        personal: fakeClient([], [], Object.assign(new Error('grant-personal exploded'), { statusCode: 500 })),
      },
    });
    const out = await mailboxEvidence(svc, ['bob@acme.example.com']);
    expect(out.find((e) => e.mailbox === 'work')!.sent_count).toBe(1);
    const bad = out.find((e) => e.mailbox === 'personal')!;
    expect(bad.sent_count).toBe(0);
    expect(bad.error).toBeDefined();
    expect(JSON.stringify(bad)).not.toContain('grant-personal');
  });

  it('a mailbox that times out is labelled TimeoutError and logged by name (SF4, SF12)', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const svc = stubPrincipalMailboxes({
        mailboxes,
        gatewayClients: {
          work: fakeClient([], []),
          personal: { listFolders: () => new Promise(() => {}), listMessages: async () => [] },
        },
      });
      const pending = mailboxEvidence(svc, ['bob@acme.example.com'], { log: { warn } as never });
      await vi.advanceTimersByTimeAsync(8_000);
      const out = await pending;
      expect(out.find((e) => e.mailbox === 'personal')!.error).toBe('TimeoutError');
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'personal', errName: 'TimeoutError' }), expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans hostile subjects inside mailboxEvidence', async () => {
    const hostile = 'Hi\n\u0000<script>x</script>\u202eevil\u200b &#91;link&#93;(http://e.example) ' + '😀'.repeat(100);
    const svc = stubPrincipalMailboxes({
      mailboxes,
      gatewayClients: {
        work: fakeClient([msg('1', 1000, { to: [{ email: 'bob@acme.example.com' }], subject: hostile })], []),
        personal: fakeClient([], []),
      },
    });
    const out = await mailboxEvidence(svc, ['bob@acme.example.com']);
    const subject = out.find((e) => e.mailbox === 'work')!.recent_subjects[0]!;
    expect(subject).not.toMatch(/[\u0000-\u001f\u202a-\u202e\u200b-\u200f\u2066-\u2069<>]/);
    expect(subject).not.toContain('&#');
    expect(Array.from(subject).length).toBeLessThanOrEqual(80);
    expect(subject).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('caps a long subject at exactly 80 characters with an ellipsis', async () => {
    const svc = stubPrincipalMailboxes({
      mailboxes,
      gatewayClients: {
        work: fakeClient([msg('1', 1000, { to: [{ email: 'bob@acme.example.com' }], subject: 'x'.repeat(200) })], []),
        personal: fakeClient([], []),
      },
    });
    const out = await mailboxEvidence(svc, ['bob@acme.example.com']);
    const subject = out.find((e) => e.mailbox === 'work')!.recent_subjects[0]!;
    expect(subject).toBe(`${'x'.repeat(79)}…`);
  });
});

describe('chosenAccountFields (D5: mention the account only on a judgement call)', () => {
  it('drops the label and says not to name the account when the evidence agrees', () => {
    expect(chosenAccountFields('work', 'Work', { evidence: 'agrees' })).toEqual({ mailbox: 'work', evidence: 'agrees', account_note: ACCOUNT_NOT_IN_DOUBT });
  });

  it.each(['leans_other', 'none', 'split'] as const)('keeps the label when the evidence is %s', (verdict) => {
    expect(chosenAccountFields('personal', 'Personal', { evidence: verdict })).toEqual({ mailbox: 'personal', mailbox_label: 'Personal', evidence: verdict });
  });

  it('keeps the label when the evidence could not be read', () => {
    expect(chosenAccountFields('work', 'Work', { evidence_unavailable: true })).toEqual({ mailbox: 'work', mailbox_label: 'Work', evidence_unavailable: true });
  });
});
