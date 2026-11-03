// handler.test.ts — unit tests for email-draft-save skill.

import { describe, it, expect, vi } from 'vitest';
import { EmailDraftSaveHandler, PRINCIPAL_MAILBOX_ERROR } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

// --- Shared test helpers ---

const ALICE_ID = '11111111-1111-4111-8111-111111111111';

const BASE_INPUT = {
  to: ALICE_ID,
  subject: 'Hello',
  body: 'Hi there',
  account: 'ceo',
};

// A mock outboundGateway that returns a successful draft creation result
function makeMockGateway(overrides?: {
  createEmailDraft?: ReturnType<typeof vi.fn>;
  isPrincipalMailbox?: ReturnType<typeof vi.fn>;
}) {
  const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
    if (value === ALICE_ID) {
      return { ok: true, kind: 'contact', contactId: ALICE_ID, identifier: 'alice@example.com', displayName: 'Alice', identityName: 'work', identityId: 'id-a' };
    }
    if (value === 'principal') {
      return { ok: true, kind: 'principal', contactId: 'p-1', identifier: 'ceo@example.com', displayName: 'P', identityName: 'primary', identityId: 'id-p' };
    }
    return { ok: false, error: `to takes a contact ID or "principal", not "${value}". Someone who is not a contact yet must be added first with contact-create, which returns their contact ID.` };
  });
  return {
    createEmailDraft: overrides?.createEmailDraft
      ?? vi.fn().mockResolvedValue({ success: true, draftId: 'draft-abc' }),
    resolveRecipientReference,
    isPrincipalMailbox: overrides?.isPrincipalMailbox ?? vi.fn().mockReturnValue(false),
    // Other gateway methods are not used by this skill — typed as unknown
  } as unknown as ToolContext['outboundGateway'];
}

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    input: BASE_INPUT,
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    outboundGateway: makeMockGateway(),
    taskMetadata: {},
    taskEventId: undefined,
    ...overrides,
  } as ToolContext;
}

// --- Baseline behaviour tests ---

describe('EmailDraftSaveHandler — baseline', () => {
  it('returns error when outboundGateway is missing', async () => {
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({ outboundGateway: undefined }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('outboundGateway');
  });

  it('returns error when "to" field is missing', async () => {
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({ input: { ...BASE_INPUT, to: '' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('to');
  });

  it('returns error when "subject" field is missing', async () => {
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({ input: { ...BASE_INPUT, subject: '' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('subject');
  });

  it('returns error when "body" field is missing', async () => {
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({ input: { ...BASE_INPUT, body: '' } }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('body');
  });

  it('creates a draft and returns draft_id on success', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, draftId: 'draft-abc' });
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({
      outboundGateway: makeMockGateway({ createEmailDraft: create }),
    }));
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({
      draft_id: 'draft-abc',
      mailbox: 'curia',
      account: 'ceo',
      to_identity: 'work',
      contact_id: ALICE_ID,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice@example.com' }));
  });

  it('returns error when gateway rejects the draft', async () => {
    const handler = new EmailDraftSaveHandler();
    const gateway = makeMockGateway({
      createEmailDraft: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Contact blocked' }),
    });
    const result = await handler.execute(makeCtx({ outboundGateway: gateway }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Contact blocked');
  });

  it('returns error when gateway throws', async () => {
    const handler = new EmailDraftSaveHandler();
    const gateway = makeMockGateway({
      createEmailDraft: vi.fn().mockRejectedValue(new Error('Network failure')),
    });
    const result = await handler.execute(makeCtx({ outboundGateway: gateway }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('Failed to save draft');
  });
});

describe('EmailDraftSaveHandler — attachments', () => {
  it('passes attachments to the gateway when provided', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ success: true, draftId: 'draft-with-attach' });
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({
      input: {
        ...BASE_INPUT,
        attachments: [
          { file_url: 'file:///tmp/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' },
        ],
      },
      outboundGateway: makeMockGateway({ createEmailDraft: mockCreate }),
    }));

    expect(result.success).toBe(true);
    const callArg = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.attachments).toEqual([
      { fileUrl: 'file:///tmp/report.pdf', filename: 'report.pdf', contentType: 'application/pdf' },
    ]);
  });

  it('does not include attachments key when attachments is absent', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ success: true, draftId: 'draft-no-attach' });
    const handler = new EmailDraftSaveHandler();
    await handler.execute(makeCtx({
      outboundGateway: makeMockGateway({ createEmailDraft: mockCreate }),
    }));

    const callArg = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.attachments).toBeUndefined();
  });

  it('returns error when attachments is not an array', async () => {
    const mockCreate = vi.fn();
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({
      input: { ...BASE_INPUT, attachments: 'not-an-array' },
      outboundGateway: makeMockGateway({ createEmailDraft: mockCreate }),
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('array');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns error when an attachment entry is missing filename', async () => {
    const mockCreate = vi.fn();
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({
      input: {
        ...BASE_INPUT,
        attachments: [{ file_url: 'file:///tmp/a.pdf', content_type: 'application/pdf' }],
      },
      outboundGateway: makeMockGateway({ createEmailDraft: mockCreate }),
    }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('filename');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('EmailDraftSaveHandler — recipient reference (#2041)', () => {
  it('refuses a typed address and saves nothing', async () => {
    const create = vi.fn();
    const result = await new EmailDraftSaveHandler().execute(makeCtx({
      input: { ...BASE_INPUT, to: 'alice@example.com' },
      outboundGateway: makeMockGateway({ createEmailDraft: create }),
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/contact-create/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses more than one recipient', async () => {
    const result = await new EmailDraftSaveHandler().execute(makeCtx({ input: { ...BASE_INPUT, to: `${ALICE_ID}, principal` } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/single recipient/);
  });

  it('omits contact_id for the principal alias', async () => {
    const result = await new EmailDraftSaveHandler().execute(makeCtx({ input: { ...BASE_INPUT, to: 'principal' } }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ draft_id: 'draft-abc', mailbox: 'curia', account: 'ceo', to_identity: 'primary' });
    }
  });
});

// Prompt trim PR 6: the principal's mailbox is ceo-inbox's, so the coordinator is told
// where the draft goes instead of drafting there.
describe('EmailDraftSaveHandler — principal mailbox', () => {
  const principalMailbox = () => vi.fn((account?: string) => account === 'ceo');

  it('refuses a coordinator draft in the principal\'s mailbox before resolving anyone', async () => {
    const create = vi.fn();
    const gateway = makeMockGateway({ createEmailDraft: create, isPrincipalMailbox: principalMailbox() });
    const result = await new EmailDraftSaveHandler().execute(makeCtx({ agentId: 'coordinator', outboundGateway: gateway }));
    expect(result).toEqual({ success: false, error: PRINCIPAL_MAILBOX_ERROR });
    expect(PRINCIPAL_MAILBOX_ERROR).toMatch(/ceo-inbox/);
    expect(create).not.toHaveBeenCalled();
    expect((gateway as unknown as { resolveRecipientReference: ReturnType<typeof vi.fn> }).resolveRecipientReference)
      .not.toHaveBeenCalled();
  });

  it('lets the coordinator draft in its own mailbox', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, draftId: 'draft-own' });
    const gateway = makeMockGateway({ createEmailDraft: create, isPrincipalMailbox: principalMailbox() });
    const result = await new EmailDraftSaveHandler().execute(makeCtx({
      agentId: 'coordinator',
      input: { ...BASE_INPUT, account: 'curia' },
      outboundGateway: gateway,
    }));
    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'curia' }));
  });

  it('checks the primary mailbox when account is omitted', async () => {
    const isPrincipalMailbox = vi.fn().mockReturnValue(true);
    const gateway = makeMockGateway({ isPrincipalMailbox });
    const { account: _omitted, ...input } = BASE_INPUT;
    const result = await new EmailDraftSaveHandler().execute(makeCtx({ agentId: 'coordinator', input, outboundGateway: gateway }));
    expect(result.success).toBe(false);
    expect(isPrincipalMailbox).toHaveBeenCalledWith(undefined);
  });

  it('leaves other agents\' drafts alone', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, draftId: 'draft-debrief' });
    const gateway = makeMockGateway({ createEmailDraft: create, isPrincipalMailbox: principalMailbox() });
    const result = await new EmailDraftSaveHandler().execute(makeCtx({ agentId: 'meeting-debrief', outboundGateway: gateway }));
    expect(result.success).toBe(true);
  });
});

// #2431: an agent told the principal "check your drafts" for a draft in Curia's mailbox.
describe('EmailDraftSaveHandler — mailbox in the result', () => {
  it("names Curia's mailbox and the primary account when account is omitted", async () => {
    const { account: _omitted, ...input } = BASE_INPUT;
    const result = await new EmailDraftSaveHandler().execute(makeCtx({ agentId: 'meeting-debrief', input }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ mailbox: 'curia', account: 'primary' });
  });

  it("names the principal's mailbox when the account is bound to the principal's address", async () => {
    const gateway = makeMockGateway({ isPrincipalMailbox: vi.fn((account?: string) => account === 'ceo') });
    const result = await new EmailDraftSaveHandler().execute(makeCtx({ agentId: 'meeting-debrief', outboundGateway: gateway }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ mailbox: 'principal', account: 'ceo' });
  });
});

// --- Reply quote (#2312) ---

describe('EmailDraftSaveHandler — reply quote', () => {
  it('passes the quote and its participants separately from the body, so the gateway can review it', async () => {
    const gateway = makeMockGateway() as unknown as Record<string, unknown>;
    gateway['getEmailMessage'] = vi.fn().mockResolvedValue({
      from: [{ email: 'Alice@Example.com' }], to: [{ email: 'ceo@example.com' }], cc: [{ email: 'ops@example.com' }],
      subject: 'Hello', body: 'Call me at 416-555-0199', date: 0,
    });
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx({
      input: { ...BASE_INPUT, reply_to_message_id: 'msg-1' },
      outboundGateway: gateway as unknown as ToolContext['outboundGateway'],
    }));
    expect(result.success).toBe(true);
    const req = vi.mocked(gateway['createEmailDraft'] as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(req.body).toBe('Hi there');
    expect(req.htmlQuote).toContain('416-555-0199');
    expect(req.quoteParticipants).toEqual(['alice@example.com', 'ceo@example.com', 'ops@example.com']);
    expect(req.replyToMessageId).toBe('msg-1');
  });

  it('saves the body alone when the original cannot be fetched', async () => {
    const gateway = makeMockGateway() as unknown as Record<string, unknown>;
    gateway['getEmailMessage'] = vi.fn().mockRejectedValue(new Error('nylas down'));
    const handler = new EmailDraftSaveHandler();
    await handler.execute(makeCtx({
      input: { ...BASE_INPUT, reply_to_message_id: 'msg-1' },
      outboundGateway: gateway as unknown as ToolContext['outboundGateway'],
    }));
    const req = vi.mocked(gateway['createEmailDraft'] as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(req.body).toBe('Hi there');
    expect(req).not.toHaveProperty('htmlQuote');
    expect(req).not.toHaveProperty('quoteParticipants');
  });
});
