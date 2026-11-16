import { describe, it, expect, vi } from 'vitest';
import { REDACTION_NOTE } from '../../src/skills/_shared/principal-directed.js';
import { SlackSendHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import pino from 'pino';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input: {},
    log: pino({ level: 'silent' }),
    agentId: 'coordinator',
    ...overrides,
  } as ToolContext;
}

// Stored identities the handler must refuse, each reachable through its own reference.
// Enterprise Grid W… ids, channel ids and lowercase u… ids are not Slack user ids it can DM.
const UNSUPPORTED_IDENTITIES: Record<string, string> = {
  'grid-user': 'W012ABCDEF',
  'channel-user': 'C012CHANNEL',
  'lowercase-user': 'u012abcdef',
};

/** Stands in for the gateway's reference resolver (#2033); its rules are tested elsewhere. */
const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
  if (value === 'principal') return { ok: true, kind: 'principal', contactId: 'principal-id', identifier: 'U0PRINCIPAL', displayName: 'Principal' };
  const unsupported = UNSUPPORTED_IDENTITIES[value];
  if (unsupported) return { ok: true, kind: 'contact', contactId: 'other-id', identifier: unsupported, displayName: 'Other' };
  return { ok: false, error: `No contact for "${value}". Nothing was sent.` };
});

describe('slack-send handler', () => {
  it('asks for a recipient and points to contact-create when none is given', async () => {
    const send = vi.fn();
    const result = await new SlackSendHandler().execute(makeCtx({
      input: { message: 'hi' },
      outboundGateway: { send, resolveRecipientReference } as never,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/contact-create/);
    expect(send).not.toHaveBeenCalled();
  });

  // Scenario 34k (as signal-send): an identity label gives the agent nothing to match the
  // principal's answer to, so a held send is named by the contact.
  it('names a held send by the contact\'s name, falling back to the identity label', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: '1.9' });
    const resolve = (displayName: string) => vi.fn().mockResolvedValue({
      ok: true, kind: 'contact', contactId: 'dana-id', identifier: 'U0DANAREYES', displayName, identityName: 'unlabelled',
    });
    await new SlackSendHandler().execute(makeCtx({
      input: { recipient: 'dana-id', message: 'hi' },
      outboundGateway: { send, resolveRecipientReference: resolve('Dana Reyes') } as never,
    }));
    expect(send.mock.calls[0]![1].holdRecipe.description).toBe('Slack message to Dana Reyes');
    await new SlackSendHandler().execute(makeCtx({
      input: { recipient: 'dana-id', message: 'hi' },
      outboundGateway: { send, resolveRecipientReference: resolve('  ') } as never,
    }));
    expect(send.mock.calls[1]![1].holdRecipe.description).toBe('Slack message to unlabelled');
  });

  it('rejects missing gateway', async () => {
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient: 'principal', message: 'hi' },
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('surfaces blockedReason when gateway refuses', async () => {
    const send = vi.fn().mockResolvedValue({ success: false, blockedReason: 'contact blocked' });
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient: 'principal', message: 'Hello' },
      outboundGateway: { send, resolveRecipientReference } as never,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('contact blocked');
  });

  describe('send by reference (#2033)', () => {
    it('resolves recipient through the gateway and DMs the looked-up user id', async () => {
      const send = vi.fn().mockResolvedValue({ success: true, messageId: '1.1' });
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'principal', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(true);
      expect(resolveRecipientReference).toHaveBeenCalledWith('slack', 'principal', { field: 'recipient' });
      expect(send).toHaveBeenCalledWith(
        { channel: 'slack', slackChannelId: 'U0PRINCIPAL', slackUserId: 'U0PRINCIPAL', message: 'Hello' },
        // Replayed on approval if band review holds the send (#2159).
        expect.objectContaining({
          holdRecipe: { toolName: 'slack-send', partialPayload: { recipient: 'principal', message: 'Hello' }, description: expect.stringMatching(/^Slack message to /) },
        }),
      );
      if (result.success) {
        expect(result.data).toMatchObject({ delivered_to: 'U0PRINCIPAL' });
        expect(result.data).not.toHaveProperty('contact_id');
      }
    });

    it.each(Object.entries(UNSUPPORTED_IDENTITIES))(
      'refuses a stored identity that is not a U… user id (%s)',
      async (reference, identifier) => {
        const send = vi.fn();
        const result = await new SlackSendHandler().execute(makeCtx({
          input: { recipient: reference, message: 'Hello' },
          outboundGateway: { send, resolveRecipientReference } as never,
        }));
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toMatch(/not a U… user id/);
          // The stored id stays out of the agent-facing error.
          expect(result.error).not.toContain(identifier);
        }
        expect(send).not.toHaveBeenCalled();
      },
    );

    it('passes an approved replay on as humanApproved, so band review does not hold it again (#2159)', async () => {
      const send = vi.fn().mockResolvedValue({ success: true, messageId: '1.2' });
      await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'principal', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
        humanApproved: true,
      }));
      expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ humanApproved: true }));
    });

    it('sends nothing when the reference does not resolve', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'U012ABCDEF', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the retired recipient_user_id (#2041)', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'principal', recipient_user_id: 'U012ABCDEF', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/no longer accepted/);
        expect(result.error).toMatch(/contact-create/);
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the retired recipient_user_id on its own (#2041)', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient_user_id: 'U012ABCDEF', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no longer accepted/);
      expect(send).not.toHaveBeenCalled();
    });

    // Review Focus 1: models fill unused optional inputs with "" or whitespace.
    it.each([[''], ['  '], [null], [[]]])(
      'ignores a blank retired recipient_user_id %o beside a reference (Review Focus 1)',
      async (blank) => {
        const send = vi.fn().mockResolvedValue({ success: true, messageId: '1.2' });
        const result = await new SlackSendHandler().execute(makeCtx({
          input: { recipient: 'principal', recipient_user_id: blank, message: 'Hello' },
          outboundGateway: { send, resolveRecipientReference } as never,
        }));
        expect(result.success).toBe(true);
        expect(send).toHaveBeenCalledWith(
          { channel: 'slack', slackChannelId: 'U0PRINCIPAL', slackUserId: 'U0PRINCIPAL', message: 'Hello' },
          expect.any(Object),
        );
      },
    );
  });
});

describe('slack-send relay budget (#1320)', () => {
  const OUTSIDER = { originator: { contactId: 'dana-contact', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known' } };

  it('passes the task originator to the gateway and surfaces a relay-budget deferral', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, deferredToDigest: true });
    const outboundContext = { register: vi.fn().mockResolvedValue('entry-1'), release: vi.fn(), defaultExpiryHours: 6, explicitExpiryHours: 24, defaultExpiryHoursFor: () => 6 };
    const result = await new SlackSendHandler().execute(makeCtx({
      input: { recipient: 'principal', message: 'Hello' },
      outboundGateway: { send, resolveRecipientReference } as never,
      taskMetadata: OUTSIDER,
      outboundContext: outboundContext as never,
    }));
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ originator: OUTSIDER.originator }));
    expect(result.success).toBe(true);
    // Nothing reached the principal, so no reply should bind to it.
    expect(outboundContext.register).not.toHaveBeenCalled();
    if (result.success) expect(result.data).toMatchObject({ deferred_to_digest: true, note: expect.stringMatching(/digest/) });
  });
});

// #2261: the entry records who the message went to, so their reply sees it.
describe('slack-send outbound-context recipients (#2261)', () => {
  it('registers the resolved contact as the entry\'s recipient', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: '1.3' });
    const register = vi.fn().mockResolvedValue('entry-1');
    const result = await new SlackSendHandler().execute(makeCtx({
      input: { recipient: 'principal', message: 'Which day works?' },
      outboundGateway: { send, resolveRecipientReference } as never,
      outboundContext: { register, release: vi.fn(), defaultExpiryHours: 6, explicitExpiryHours: 24, defaultExpiryHoursFor: () => 6 } as never,
    }));
    expect(result.success).toBe(true);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ recipientContactIds: ['principal-id'] }));
  });
});

// #2312: the agent is told what was removed, and the entry records what was delivered.
describe('slack-send redactions (#2312)', () => {
  const RED = [{ label: 'phone_us', field: 'body' as const }];
  const SENT = 'x [REDACTED: PHONE_US]';
  const OC = () => { const register = vi.fn().mockResolvedValue('entry-1'); return { register, ctx: { register, release: vi.fn(), defaultExpiryHours: 6, explicitExpiryHours: 24, defaultExpiryHoursFor: () => 6 } as never }; };

  it('reports the redactions and records the delivered content', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: 'm', redactions: RED, sentContent: SENT });
    const oc = OC();
    const result = await new SlackSendHandler().execute(makeCtx({
      input: { recipient: 'principal', message: 'x 519-555-0100' },
      outboundGateway: { send, resolveRecipientReference } as never,
      outboundContext: oc.ctx,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ redactions: RED, redaction_note: REDACTION_NOTE });
    }
    expect(oc.register).toHaveBeenCalledWith(expect.objectContaining({ content: SENT }));
  });

  it('adds no redactions key when nothing was removed', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: 'm' });
    const oc = OC();
    const result = await new SlackSendHandler().execute(makeCtx({
      input: { recipient: 'principal', message: 'hello' },
      outboundGateway: { send, resolveRecipientReference } as never,
      outboundContext: oc.ctx,
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('redactions');
      expect(result.data).not.toHaveProperty('redaction_note');
    }
    expect(oc.register).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }));
  });
});
