import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { MultiPrincipalMailbox } from '../../../src/contacts/multi-principal-mailbox.js';
import type { PrincipalMailboxView } from '../../../src/principal-mailboxes/service.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';

const logger = pino({ level: 'silent' });

function view(id: string): PrincipalMailboxView {
  return { id, label: id, address: `${id}@example.com`, isDefault: id === 'work', triageStartAt: null };
}

function client(opts: { to?: string[]; bcc?: string[]; fail?: boolean; noSent?: boolean; hang?: boolean }) {
  return {
    listFolders: vi.fn(async () => {
      if (opts.fail) throw new Error('boom grant-secret-123');
      if (opts.hang) return new Promise<never>(() => {});
      return opts.noSent ? [{ id: 'INBOX', attributes: ['\\Inbox'] }] : [{ id: 'SENT', attributes: ['\\Sent'] }];
    }),
    listMessages: vi.fn(async () => [{ id: 'm1', to: (opts.to ?? []).map((email) => ({ email })), cc: [], bcc: (opts.bcc ?? []).map((email) => ({ email })) }]),
  };
}

/** The service stub: credentials name the mailbox's grant (`grant-<id>`, or `grants[id]`). */
function mailboxes(byId: Record<string, ReturnType<typeof client>>, grants: Record<string, string> = {}) {
  return {
    list: vi.fn(async () => Object.keys(byId).map(view)),
    credentials: vi.fn(async (id: string) => ({ apiKey: 'key', grantId: grants[id] ?? `grant-${id}` })),
  } as unknown as ConstructorParameters<typeof MultiPrincipalMailbox>[0];
}

/** Builds each mailbox's fake client from its grant id. */
function factory(byId: Record<string, ReturnType<typeof client>>) {
  return vi.fn((_key: string, grant: string) => byId[grant.replace(/^grant-/, '').replace(/-v\d+$/, '')] as unknown as NylasClient);
}

function make(byId: Record<string, ReturnType<typeof client>>, timeoutMs = 5_000, log = logger) {
  const svc = mailboxes(byId);
  return { svc, mailbox: new MultiPrincipalMailbox(svc, log, timeoutMs, factory(byId)) };
}

describe('MultiPrincipalMailbox', () => {
  it('hasSentTo is true when any mailbox has sent', async () => {
    const { mailbox } = make({ work: client({ to: [] }), personal: client({ to: ['Dana@Example.org'] }) });
    await expect(mailbox.hasSentTo('dana@example.org')).resolves.toBe(true);
  });

  it('counts a recipient the principal sent to only in bcc', async () => {
    const { mailbox } = make({ work: client({ bcc: ['dana@example.org'] }) });
    await expect(mailbox.hasSentTo('dana@example.org')).resolves.toBe(true);
  });

  it('is true even when another mailbox failed', async () => {
    const { mailbox } = make({ work: client({ fail: true }), personal: client({ to: ['dana@example.org'] }) });
    await expect(mailbox.hasSentTo('dana@example.org')).resolves.toBe(true);
  });

  it('is false when every readable mailbox says no, even if one failed', async () => {
    const { mailbox } = make({ work: client({ fail: true }), personal: client({ to: ['other@example.org'] }) });
    await expect(mailbox.hasSentTo('dana@example.org')).resolves.toBe(false);
  });

  it('throws when every mailbox fails', async () => {
    const { mailbox } = make({ work: client({ fail: true }), personal: client({ noSent: true }) });
    await expect(mailbox.hasSentTo('dana@example.org')).rejects.toThrow();
  });

  it('treats a mailbox that misses the deadline as failed', async () => {
    const { mailbox } = make({ work: client({ hang: true }) }, 20);
    await expect(mailbox.hasSentTo('dana@example.org')).rejects.toThrow();
  });

  it('a mailbox list that hangs is bounded by the same deadline (item 10)', async () => {
    const svc = { list: () => new Promise<never>(() => {}), credentials: vi.fn() } as unknown as ConstructorParameters<typeof MultiPrincipalMailbox>[0];
    await expect(new MultiPrincipalMailbox(svc, logger, 20).hasSentTo('dana@example.org')).rejects.toThrow(/timed out/);
  });

  it('reuses a mailbox client while its grant is unchanged, and rebuilds it when the grant changes (B7)', async () => {
    const work = client({ to: [] });
    const grants: Record<string, string> = {};
    const svc = mailboxes({ work }, grants);
    const create = factory({ work });
    const m = new MultiPrincipalMailbox(svc, logger, 5_000, create);
    await m.hasSentTo('a@example.org');
    await m.hasSentTo('b@example.org');
    expect(create).toHaveBeenCalledTimes(1);
    grants['work'] = 'grant-work-v2';
    await m.hasSentTo('c@example.org');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith('key', 'grant-work-v2', 5_000);
  });

  it('is false with no live mailbox, and false for a non-plain address without a lookup', async () => {
    // No mailbox is a steady state, answered false (and cached), not a throw that warns per sender (item 9).
    await expect(make({}).mailbox.hasSentTo('dana@example.org')).resolves.toBe(false);
    const { svc, mailbox } = make({ work: client({}) });
    await expect(mailbox.hasSentTo('a b@example.org')).resolves.toBe(false);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('logs no grant detail from a failing mailbox', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'warn' }, { write: (s: string) => { lines.push(s); } });
    const { mailbox } = make({ work: client({ fail: true }), personal: client({ to: ['dana@example.org'] }) }, 5_000, log);
    await mailbox.hasSentTo('dana@example.org');
    expect(lines.join('')).toContain('"mailboxId":"work"');
    expect(lines.join('')).not.toContain('grant-secret-123');
  });
});
