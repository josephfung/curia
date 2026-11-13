import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { MultiPrincipalMailbox } from '../../../src/contacts/multi-principal-mailbox.js';
import type { PrincipalMailboxView } from '../../../src/principal-mailboxes/service.js';

const logger = pino({ level: 'silent' });

function view(id: string): PrincipalMailboxView {
  return { id, label: id, address: `${id}@example.com`, isDefault: id === 'work', triageStartAt: null };
}

function client(opts: { to?: string[]; fail?: boolean; noSent?: boolean; hang?: boolean }) {
  return {
    listFolders: vi.fn(async () => {
      if (opts.fail) throw new Error('boom grant-secret-123');
      if (opts.hang) return new Promise<never>(() => {});
      return opts.noSent ? [{ id: 'INBOX', attributes: ['\\Inbox'] }] : [{ id: 'SENT', attributes: ['\\Sent'] }];
    }),
    listMessages: vi.fn(async () => [{ id: 'm1', to: (opts.to ?? []).map((email) => ({ email })), cc: [] }]),
  };
}

function mailboxes(byId: Record<string, ReturnType<typeof client>>) {
  return {
    list: vi.fn(async () => Object.keys(byId).map(view)),
    gatewayClient: vi.fn(async (id: string) => byId[id]),
  } as unknown as ConstructorParameters<typeof MultiPrincipalMailbox>[0];
}

describe('MultiPrincipalMailbox', () => {
  it('hasSentTo is true when any mailbox has sent', async () => {
    const svc = mailboxes({ work: client({ to: [] }), personal: client({ to: ['Dana@Example.org'] }) });
    await expect(new MultiPrincipalMailbox(svc, logger).hasSentTo('dana@example.org')).resolves.toBe(true);
  });

  it('is true even when another mailbox failed', async () => {
    const svc = mailboxes({ work: client({ fail: true }), personal: client({ to: ['dana@example.org'] }) });
    await expect(new MultiPrincipalMailbox(svc, logger).hasSentTo('dana@example.org')).resolves.toBe(true);
  });

  it('is false when every readable mailbox says no, even if one failed', async () => {
    const svc = mailboxes({ work: client({ fail: true }), personal: client({ to: ['other@example.org'] }) });
    await expect(new MultiPrincipalMailbox(svc, logger).hasSentTo('dana@example.org')).resolves.toBe(false);
  });

  it('throws when every mailbox fails', async () => {
    const svc = mailboxes({ work: client({ fail: true }), personal: client({ noSent: true }) });
    await expect(new MultiPrincipalMailbox(svc, logger).hasSentTo('dana@example.org')).rejects.toThrow();
  });

  it('treats a mailbox that misses the deadline as failed', async () => {
    const svc = mailboxes({ work: client({ hang: true }) });
    await expect(new MultiPrincipalMailbox(svc, logger, 20).hasSentTo('dana@example.org')).rejects.toThrow();
  });

  it('is false with no live mailbox, and false for a non-plain address without a lookup', async () => {
    const none = mailboxes({});
    await expect(new MultiPrincipalMailbox(none, logger).hasSentTo('dana@example.org')).resolves.toBe(false);
    const svc = mailboxes({ work: client({}) });
    await expect(new MultiPrincipalMailbox(svc, logger).hasSentTo('a b@example.org')).resolves.toBe(false);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it('logs no grant detail from a failing mailbox', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'warn' }, { write: (s: string) => { lines.push(s); } });
    const svc = mailboxes({ work: client({ fail: true }), personal: client({ to: ['dana@example.org'] }) });
    await new MultiPrincipalMailbox(svc, log).hasSentTo('dana@example.org');
    expect(lines.join('')).toContain('"mailboxId":"work"');
    expect(lines.join('')).not.toContain('grant-secret-123');
  });
});
