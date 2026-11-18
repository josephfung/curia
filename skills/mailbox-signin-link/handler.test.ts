// handler.test.ts — mailbox-signin-link skill (#2361). The service is faked: these cover the
// handler's own rules (capability gate, the for:'curia' gate, output shape and leak surface).

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { MailboxSignInLinkHandler } from './handler.js';
import { MailboxSignInAddressError, MailboxSignInRefusedError, MailboxSignInUnavailableError, type MailboxSignInMinter, type MintSignInArgs } from '../../src/nylas/mailbox-signin-service.js';
import type { ToolContext } from '../../src/skills/types.js';
import { serializeForLeakCheck } from '../../tests/helpers/leak-check.js';

const URL_OUT = 'https://curia.example.com/api/mailbox-signin/start/AbCdEfGhIjKlMnOpQrSt12';

function fakeMinter(opts: { unavailable?: boolean; boom?: boolean; badAddress?: boolean; curiaExists?: boolean } = {}): MailboxSignInMinter & { calls: MintSignInArgs[] } {
  const calls: MintSignInArgs[] = [];
  return {
    calls,
    async mint(args) {
      calls.push(args);
      if (opts.unavailable) throw new MailboxSignInUnavailableError('origin_not_https', 'Sign-in needs APP_ORIGIN set to an https:// address.');
      if (opts.badAddress) throw new MailboxSignInAddressError('unknown_principal_address');
      if (opts.curiaExists) throw new MailboxSignInRefusedError('curia_mailbox_exists');
      if (opts.boom) throw new Error('connection refused at 10.0.0.5:5432');
      return { url: URL_OUT, expiresAt: new Date(Date.now() + 60 * 60_000) };
    },
  };
}

function makeCtx(
  input: Record<string, unknown>,
  over: { minter?: MailboxSignInMinter | undefined; agentId?: string } = {},
): ToolContext {
  return {
    input,
    secret: () => 'unused',
    log: pino({ level: 'silent' }),
    mailboxSignIn: 'minter' in over ? over.minter : fakeMinter(),
    agentId: over.agentId ?? 'coordinator',
    conversationId: 'conv-1',
    channelId: 'web',
    taskEventId: 'evt-1',
    timezone: 'America/Toronto',
  } as unknown as ToolContext;
}

describe('MailboxSignInLinkHandler', () => {
  it('rejects a call made without the mailboxSignIn capability', async () => {
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({}, { minter: undefined }));
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('mailboxSignIn capability') });
  });

  it('mints a principal link by default, returns the URL, and passes no address from input', async () => {
    const minter = fakeMinter();
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({ mailbox_label: ' Work ', expected_email: 'evil@example.com' }, { minter }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data.sign_in_url).toBe(URL_OUT);
    expect(data.target).toBe('principal');
    expect(minter.calls).toHaveLength(1);
    expect(minter.calls[0]).toMatchObject({ target: 'principal', label: 'Work' });
    // The address is the service's to fill; nothing the model wrote reaches the mint.
    expect(minter.calls[0]).not.toHaveProperty('expectedEmail');
    expect(JSON.stringify(minter.calls[0])).not.toContain('evil@example.com');
    expect(minter.calls[0]!.origin).toMatchObject({ conversationId: 'conv-1', channelId: 'web', agentId: 'coordinator', taskEventId: 'evt-1' });
  });

  it('tells the agent to relay the link verbatim and to warn about the Google screens', async () => {
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({}));
    if (!result.success) throw new Error('expected success');
    const summary = (result.data as { summary: string }).summary;
    expect(summary).toContain('EXACTLY');
    expect(summary).toContain('unverified app');
    expect(summary).toContain('twice');
    expect(summary).toMatch(/both permission boxes/);
  });

  it('output carries the link and expiry but no grant id, key or address', async () => {
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({}));
    expect(result.success).toBe(true);
    const serialized = serializeForLeakCheck(result);
    expect(serialized).toContain(URL_OUT);
    expect(serialized).not.toMatch(/grant/i);
    expect(serialized).not.toMatch(/api[_ ]?key/i);
    expect(serialized).not.toContain('@');
  });

  it("refuses for:'curia' from the coordinator and never mints", async () => {
    const minter = fakeMinter();
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({ for: 'curia' }, { minter, agentId: 'coordinator' }));
    expect(result.success).toBe(false);
    expect(minter.calls).toHaveLength(0);
  });

  it("allows for:'curia' from setup-wizard", async () => {
    const minter = fakeMinter();
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({ for: 'curia' }, { minter, agentId: 'setup-wizard' }));
    expect(result.success).toBe(true);
    expect(minter.calls[0]).toMatchObject({ target: 'curia' });
  });

  it('rejects an unknown for value and a bad label', async () => {
    const minter = fakeMinter();
    const a = await new MailboxSignInLinkHandler().execute(makeCtx({ for: 'someone-else' }, { minter }));
    const b = await new MailboxSignInLinkHandler().execute(makeCtx({ mailbox_label: '   ' }, { minter }));
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);
    expect(minter.calls).toHaveLength(0);
  });

  it('passes a requested mailbox_address to the service to validate, and reports a refusal plainly', async () => {
    const minter = fakeMinter();
    await new MailboxSignInLinkHandler().execute(makeCtx({ mailbox_address: ' Work@Example.com ' }, { minter }));
    expect(minter.calls[0]).toMatchObject({ mailboxAddress: 'Work@Example.com' });
    const refused = await new MailboxSignInLinkHandler().execute(makeCtx({ mailbox_address: 'x@y.com' }, { minter: fakeMinter({ badAddress: true }) }));
    expect(refused).toMatchObject({ success: false, error: expect.stringContaining('verified') });
  });

  it("rejects mailbox_address with for:'curia'", async () => {
    const minter = fakeMinter();
    const r = await new MailboxSignInLinkHandler().execute(makeCtx({ for: 'curia', mailbox_address: 'a@b.com' }, { minter, agentId: 'setup-wizard' }));
    expect(r.success).toBe(false);
    expect(minter.calls).toHaveLength(0);
  });

  it("returns the service's plain refusal once Curia has a mailbox, pointing at the console (R8)", async () => {
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({ for: 'curia' }, { minter: fakeMinter({ curiaExists: true }), agentId: 'setup-wizard' }));
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('console') });
  });

  it('reports an unavailable sign-in with its reason, as a result and not a throw', async () => {
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({}, { minter: fakeMinter({ unavailable: true }) }));
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('origin_not_https') });
  });

  it('turns an unexpected failure into a generic result without leaking its message', async () => {
    const result = await new MailboxSignInLinkHandler().execute(makeCtx({}, { minter: fakeMinter({ boom: true }) }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('10.0.0.5');
  });
});
