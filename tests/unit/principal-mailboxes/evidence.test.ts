import { describe, it, expect } from 'vitest';
import { mailboxEvidence, classifyEvidence, type MailboxEvidence } from '../../../src/principal-mailboxes/evidence.js';
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
});
