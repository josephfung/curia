import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendDraftHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { ActionLogRepo } from '../../../../src/autonomy/action-log-repo.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

// Minimal draft fixture — shape matches NylasMessage
const DRAFT_STUB = {
  id: 'draft-abc123',
  threadId: '',
  subject: 'Re: Project Update',
  from: [{ email: 'curia@example.com' }],
  to: [{ email: 'kevin@example.com' }],
  cc: [],
  bcc: [],
  body: '<p>Hello Kevin</p>',
  snippet: 'Hello Kevin',
  date: 1746000000, // epoch seconds
  unread: false,
  folders: ['DRAFT'],
};

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  taskMetadata?: Record<string, unknown> | undefined;
  gateway?: Partial<OutboundGateway>;
  bus?: Partial<EventBus>;
  taskEventId?: string;
  actionLogRepo?: Partial<ActionLogRepo> | null;
  disclosureDecisions?: ToolContext['disclosureDecisions'];
  liveTurn?: boolean;
}): ToolContext {
  const gateway = {
    getEmailDraft: vi.fn().mockResolvedValue(DRAFT_STUB),
    sendEmailDraft: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' }),
    listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
    ...overrides.gateway,
  } as unknown as OutboundGateway;

  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    ...overrides.bus,
  } as unknown as EventBus;

  // Build action log repo — undefined by default (matches pre-existing tests),
  // null means explicitly absent (ctx.actionLogRepo = undefined), or a partial mock.
  const actionLogRepo = overrides.actionLogRepo === null
    ? undefined
    : overrides.actionLogRepo !== undefined
      ? overrides.actionLogRepo as unknown as ActionLogRepo
      : undefined;

  const ctx = {
    input: overrides.input ?? { draft_id: 'draft-abc123', account: 'personal' },
    secret: () => '',
    log: makeLogger(),
    outboundGateway: gateway,
    bus,
    taskMetadata: 'taskMetadata' in overrides
      ? overrides.taskMetadata
      : {
          originator: {
            contactId: 'ceo-contact-id',
            systemRole: 'principal' as const,
            channel: 'signal',
            initiatedAt: new Date().toISOString(),
          },
          senderId: '+14155551234',
          channelId: 'signal',
        },
    taskEventId: overrides.taskEventId ?? 'task-event-1',
    actionLogRepo,
    ...(overrides.disclosureDecisions ? { disclosureDecisions: overrides.disclosureDecisions } : {}),
    ...(overrides.liveTurn !== undefined ? { liveTurn: overrides.liveTurn } : {}),
  } as unknown as ToolContext;

  return ctx;
}

describe('SendDraftHandler', () => {
  let handler: SendDraftHandler;

  beforeEach(() => {
    handler = new SendDraftHandler();
  });

  // ─── Security gate ────────────────────────────────────────────────────────

  it('rejects when originator is absent from taskMetadata', async () => {
    const ctx = makeCtx({ taskMetadata: {} });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/principal authorization/i);
  });

  it('rejects when originator.systemRole is not principal', async () => {
    const ctx = makeCtx({ taskMetadata: { originator: { contactId: 'other-id', systemRole: 'agent', channel: 'cli', initiatedAt: new Date().toISOString() } } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/principal authorization/i);
  });

  it('rejects when taskMetadata is undefined', async () => {
    const ctx = makeCtx({ taskMetadata: undefined });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/principal authorization/i);
  });

  // ─── Capability guards ────────────────────────────────────────────────────

  it('returns error when outboundGateway is missing', async () => {
    const ctx = makeCtx({});
    (ctx as unknown as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/i);
  });

  it('returns error when bus is missing', async () => {
    const ctx = makeCtx({});
    (ctx as unknown as Record<string, unknown>).bus = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/bus/i);
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it('returns error when draft_id is missing', async () => {
    const ctx = makeCtx({ input: { account: 'personal' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/draft_id/i);
  });

  it('auto-discovers account when account is omitted', async () => {
    // account is optional — the skill should search all accounts and find the draft.
    const ctx = makeCtx({ input: { draft_id: 'draft-abc123' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });

  // ─── Draft lookup ─────────────────────────────────────────────────────────

  it('returns error when the draft lookup throws (explicit account)', async () => {
    const ctx = makeCtx({
      gateway: {
        getEmailDraft: vi.fn().mockRejectedValue(new Error('Nylas error')),
        sendEmailDraft: vi.fn(),
        listAccountIds: vi.fn().mockReturnValue(['personal']),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/could not search/i);
      expect(result.error).toContain('personal: Nylas error');
    }
  });

  // The named-account path builds its sentence from the same flag as the all-accounts one.
  it.each([
    { statusCode: 503, wording: /transient.*try again/i },
    { statusCode: 400, wording: /not a temporary outage/i },
  ])('words a $statusCode on a named account the same as across accounts', async ({ statusCode, wording }) => {
    const err = Object.assign(new Error('Nylas said no'), { statusCode });
    const ctx = makeCtx({
      input: { draft_id: 'draft-abc123', account: 'personal' },
      gateway: { getEmailDraft: vi.fn().mockRejectedValue(err), sendEmailDraft: vi.fn() },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(wording);
  });

  it('returns error when draft is not found in DRAFTS folder (explicit account)', async () => {
    const ctx = makeCtx({
      gateway: {
        getEmailDraft: vi.fn().mockResolvedValue(null),
        sendEmailDraft: vi.fn(),
        listAccountIds: vi.fn().mockReturnValue(['personal']),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it('returns error when draft has no recipient', async () => {
    const draftNoRecipient = { ...DRAFT_STUB, to: [] };
    const ctx = makeCtx({
      gateway: {
        getEmailDraft: vi.fn().mockResolvedValue(draftNoRecipient),
        sendEmailDraft: vi.fn(),
        listAccountIds: vi.fn().mockReturnValue(['personal']),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/recipient/i);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it('sends draft successfully and returns message_id, to, subject', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.to).toBe('kevin@example.com');
      expect(data.subject).toBe('Re: Project Update');
      expect(data.message_id).toBe('msg-sent-1');
    }
  });

  it('calls gateway.sendEmailDraft with humanApproved: true and correct draftId/account', async () => {
    const sendEmailDraftMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { sendEmailDraft: sendEmailDraftMock } });
    await handler.execute(ctx);
    expect(sendEmailDraftMock).toHaveBeenCalledWith(
      'draft-abc123',
      'personal',
      expect.objectContaining({ recipientEmail: 'kevin@example.com' }),
      expect.objectContaining({ humanApproved: true }),
    );
  });

  it('passes draft body and subject to gateway for safety checks', async () => {
    const sendEmailDraftMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { sendEmailDraft: sendEmailDraftMock } });
    await handler.execute(ctx);
    expect(sendEmailDraftMock).toHaveBeenCalledWith(
      'draft-abc123',
      'personal',
      {
        recipientEmail: 'kevin@example.com',
        body: '<p>Hello Kevin</p>',
        subject: 'Re: Project Update',
        allRecipients: ['kevin@example.com'],
      },
      expect.objectContaining({ humanApproved: true }),
    );
  });

  it('passes the full To+CC+BCC envelope as allRecipients so the gateway judge sees CC recipients (#547)', async () => {
    const sendEmailDraftMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    // Draft addressed To: kevin, CC: an external third party. The gateway must
    // receive both so its Stage 2 audience-leak judge does not skip on a false
    // sole-recipient computation.
    const draftWithCc = { ...DRAFT_STUB, cc: [{ email: 'third@external.com' }] };
    const ctx = makeCtx({
      gateway: {
        getEmailDraft: vi.fn().mockResolvedValue(draftWithCc),
        sendEmailDraft: sendEmailDraftMock,
      },
    });
    await handler.execute(ctx);
    expect(sendEmailDraftMock).toHaveBeenCalledWith(
      'draft-abc123',
      'personal',
      expect.objectContaining({ allRecipients: ['kevin@example.com', 'third@external.com'] }),
      expect.objectContaining({ humanApproved: true }),
    );
  });

  it('returns error when gateway blocks the send', async () => {
    const ctx = makeCtx({
      gateway: {
        sendEmailDraft: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  it('publishes a human.decision event after successful send', async () => {
    const publishMock = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ bus: { publish: publishMock } });

    await handler.execute(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'human.decision',
        payload: expect.objectContaining({
          decision: 'approve',
          defaultAction: 'block',
        }),
      }),
    );
  });

  it('still returns success even when human.decision publish fails', async () => {
    // The message was sent — audit event failure must not retroactively fail the skill.
    const publishMock = vi.fn().mockRejectedValue(new Error('bus error'));
    const ctx = makeCtx({ bus: { publish: publishMock } });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });

  // ─── Stage 2.5 principal-directed signal (#1870) ──────────────────────────

  describe('principalDirected', () => {
    it('is false for principal lineage without a live turn (a woken task passes the origin check)', async () => {
      // A threshold-clearing wake keeps principal lineage and so passes the handler's
      // isPrincipalOriginated check, but it must not skip the disclosure gate.
      const ctx = makeCtx({});
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(ctx.outboundGateway!.sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123',
        'personal',
        expect.anything(),
        expect.objectContaining({ humanApproved: true, principalDirected: false }),
      );
      // A woken task's draft send is band-reviewed; a hold replays send-draft (#2159).
      expect(ctx.outboundGateway!.sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123',
        'personal',
        expect.anything(),
        expect.objectContaining({
          holdRecipe: {
            toolName: 'send-draft',
            // The draft's text rides in the payload, so the approval shows it after a restart (#2312).
            partialPayload: { ...ctx.input, subject: DRAFT_STUB.subject, body: DRAFT_STUB.body },
            description: expect.stringMatching(/^Send draft to /),
          },
        }),
      );
    });

    it('is true on a live principal turn', async () => {
      const ctx = makeCtx({});
      (ctx as { liveTurn?: boolean }).liveTurn = true;
      await handler.execute(ctx);
      expect(ctx.outboundGateway!.sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123',
        'personal',
        expect.anything(),
        expect.objectContaining({ principalDirected: true }),
      );
    });
  });

  // ─── principalApproved: an approval replay (#2312) ────────────────────────

  describe('principalApproved', () => {
    const approvedInput = { draft_id: 'draft-abc123', account: 'personal', subject: DRAFT_STUB.subject, body: DRAFT_STUB.body };

    function approvedCtx(input: Record<string, unknown>, humanApproved: boolean): ToolContext {
      const ctx = makeCtx({ input });
      (ctx as { humanApproved?: boolean }).humanApproved = humanApproved;
      return ctx;
    }

    it('is true on an approval replay of the draft the principal saw', async () => {
      const ctx = approvedCtx(approvedInput, true);
      await handler.execute(ctx);
      expect(ctx.outboundGateway!.sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123', 'personal', expect.anything(), expect.objectContaining({ principalApproved: true }),
      );
    });

    it('is false without an approval', async () => {
      const ctx = approvedCtx(approvedInput, false);
      await handler.execute(ctx);
      expect(ctx.outboundGateway!.sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123', 'personal', expect.anything(), expect.objectContaining({ principalApproved: false }),
      );
    });

    it('is false when the draft changed since the approval, or the approval never showed it', async () => {
      const edited = approvedCtx({ ...approvedInput, body: '<p>Hello Kevin, an older version</p>' }, true);
      await handler.execute(edited);
      expect(edited.outboundGateway!.sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123', 'personal', expect.anything(), expect.objectContaining({ principalApproved: false }),
      );
      const unseen = approvedCtx({ draft_id: 'draft-abc123', account: 'personal' }, true);
      await handler.execute(unseen);
      expect(unseen.outboundGateway!.sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123', 'personal', expect.anything(), expect.objectContaining({ principalApproved: false }),
      );
    });
  });

  // ─── Cross-account draft discovery (#455) ─────────────────────────────────

  describe('cross-account draft discovery', () => {
    it('finds draft in secondary account when account is omitted', async () => {
      // Draft lives in 'personal' (second account). getEmailDraft returns empty
      // for 'curia' but finds the draft in 'personal'.
      const getEmailDraft = vi.fn()
        .mockImplementation((_draftId: string, accountId: string) =>
          accountId === 'personal'
            ? Promise.resolve(DRAFT_STUB)
            : Promise.resolve(null),
        );
      const sendEmailDraft = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });

      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' }, // no account
        gateway: {
          getEmailDraft,
          sendEmailDraft,
          listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // Verify the send used the discovered account ('personal'), not the primary ('curia')
      expect(sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123',
        'personal',
        expect.objectContaining({ recipientEmail: 'kevin@example.com' }),
        expect.objectContaining({ humanApproved: true }),
      );
    });

    it('sends from discovered account, not primary', async () => {
      // The primary account is 'curia', but the draft is in 'personal'.
      // The send must use 'personal' credentials.
      const getEmailDraft = vi.fn()
        .mockImplementation((_draftId: string, accountId: string) =>
          accountId === 'personal'
            ? Promise.resolve(DRAFT_STUB)
            : Promise.resolve(null),
        );
      const sendEmailDraft = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });

      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' }, // no account specified
        gateway: {
          getEmailDraft,
          sendEmailDraft,
          listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
        },
      });

      await handler.execute(ctx);
      // sendEmailDraft's second argument is the accountId
      const usedAccount = sendEmailDraft.mock.calls[0]![1];
      expect(usedAccount).toBe('personal');
    });

    it('returns clear error when draft not found in any account (no fallback to creating new draft)', async () => {
      const getEmailDraft = vi.fn().mockResolvedValue(null);

      const ctx = makeCtx({
        input: { draft_id: 'draft-nonexistent' }, // no account
        gateway: {
          getEmailDraft,
          sendEmailDraft: vi.fn(),
          listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/not found/i);
        expect(result.error).toContain('curia');
        expect(result.error).toContain('personal');
      }
      // sendEmailDraft must NOT be called — no silent fallback to creating a new draft
      expect(ctx.outboundGateway!.sendEmailDraft).not.toHaveBeenCalled();
    });

    it('stops searching after first account match (short-circuits)', async () => {
      // Draft found in the first account ('curia') — should not query 'personal'.
      const getEmailDraft = vi.fn()
        .mockImplementation((_draftId: string, accountId: string) =>
          accountId === 'curia'
            ? Promise.resolve(DRAFT_STUB)
            : Promise.reject(new Error('should not be called')),
        );

      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' }, // no account
        gateway: {
          getEmailDraft,
          sendEmailDraft: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' }),
          listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      // getEmailDraft should have been called exactly once (for 'curia')
      expect(getEmailDraft).toHaveBeenCalledTimes(1);
    });

    it('continues searching when one account fetch fails', async () => {
      // 'curia' throws an error, but 'personal' has the draft — should still succeed.
      const getEmailDraft = vi.fn()
        .mockImplementation((_draftId: string, accountId: string) => {
          if (accountId === 'curia') return Promise.reject(new Error('Nylas timeout'));
          return Promise.resolve(DRAFT_STUB);
        });
      const sendEmailDraft = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });

      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' }, // no account
        gateway: {
          getEmailDraft,
          sendEmailDraft,
          listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(sendEmailDraft).toHaveBeenCalledWith(
        'draft-abc123',
        'personal',
        expect.anything(),
        expect.anything(),
      );
    });

    it('keeps a partial outage retryable, without the not-found guidance', async () => {
      // curia timed out and personal had no match. The draft may be in curia, so the
      // error must not say "do not retry" or send the model to the principal's Gmail.
      const getEmailDraft = vi.fn()
        .mockImplementation((_draftId: string, accountId: string) => {
          if (accountId === 'curia') return Promise.reject(Object.assign(new Error('Gateway Timeout'), { statusCode: 504 }));
          return Promise.resolve(null); // personal: no match
        });

      const ctx = makeCtx({
        input: { draft_id: 'draft-nonexistent' },
        gateway: {
          getEmailDraft,
          sendEmailDraft: vi.fn(),
          listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('curia: Gateway Timeout');
        expect(result.error).toContain('It is not in personal.');
        expect(result.error).toMatch(/try again shortly/i);
        expect(result.error).not.toMatch(/do not retry|Gmail Drafts|email-send|not found/i);
      }
    });

    it('calls a partial permanent failure permanent, without the not-found guidance', async () => {
      const getEmailDraft = vi.fn()
        .mockImplementation((_draftId: string, accountId: string) => {
          if (accountId === 'curia') return Promise.reject(Object.assign(new Error('Bad Request'), { statusCode: 400 }));
          return Promise.resolve(null);
        });
      const ctx = makeCtx({
        input: { draft_id: 'draft-nonexistent' },
        gateway: { getEmailDraft, sendEmailDraft: vi.fn(), listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']) },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/not a temporary outage/i);
        expect(result.error).not.toMatch(/Gmail Drafts|email-send/);
      }
    });

    it('retries when one account is down even though another rejected the request', async () => {
      // A 400 beside a 503: the retry reaches the account that was down.
      const getEmailDraft = vi.fn()
        .mockImplementation((_draftId: string, accountId: string) => Promise.reject(
          Object.assign(new Error(accountId === 'curia' ? 'Bad Request' : 'Service Unavailable'), {
            statusCode: accountId === 'curia' ? 400 : 503,
          }),
        ));
      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' },
        gateway: { getEmailDraft, sendEmailDraft: vi.fn(), listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']) },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/transient.*try again/i);
    });

    it('returns transient-error message when ALL accounts have fetch errors', async () => {
      // Every account throws — the draft was never searched, so the error should
      // say "could not search" not "not found".
      const getEmailDraft = vi.fn().mockRejectedValue(Object.assign(new Error('Nylas down'), { statusCode: 503 }));

      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' },
        gateway: {
          getEmailDraft,
          sendEmailDraft: vi.fn(),
          listAccountIds: vi.fn().mockReturnValue(['curia', 'personal']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Must NOT say "Draft not found" — it was never actually searched.
        expect(result.error).toMatch(/could not search/i);
        expect(result.error).toMatch(/transient/i);
        expect(result.error).toContain('curia');
        expect(result.error).toContain('personal');
      }
    });

    // #2262: Gmail rejected the old DRAFTS lookup with a 400 on every call, and the
    // "transient" wording sent the coordinator into days of retry tasks.
    it('does not call a rejected request transient', async () => {
      const badRequest = Object.assign(new Error('Bad Request'), { statusCode: 400 });
      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' },
        gateway: {
          getEmailDraft: vi.fn().mockRejectedValue(badRequest),
          sendEmailDraft: vi.fn(),
          listAccountIds: vi.fn().mockReturnValue(['curia']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).not.toMatch(/transient|try again/i);
        expect(result.error).toMatch(/not a temporary outage/i);
        expect(result.error).toContain('Bad Request');
      }
    });

    // A Nylas SDK timeout and Node fetch's socket failure carry no status of their own.
    class NylasSdkTimeoutError extends Error {}
    it.each([
      { label: '408', err: Object.assign(new Error('Request Timeout'), { statusCode: 408 }), transient: true },
      { label: 'the SDK timeout', err: new NylasSdkTimeoutError('Nylas SDK timed out'), transient: true },
      {
        label: 'a fetch socket error',
        err: new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }),
        transient: true,
      },
      { label: 'an unknown account', err: new Error("unknown account 'work'; available: [curia]"), transient: false },
    ])('classifies $label as transient: $transient', async ({ err, transient }) => {
      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' },
        gateway: { getEmailDraft: vi.fn().mockRejectedValue(err), sendEmailDraft: vi.fn(), listAccountIds: vi.fn().mockReturnValue(['curia']) },
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(/transient/i.test(result.error)).toBe(transient);
    });

    it.each([429, 503])('still calls a %i transient', async (statusCode) => {
      const err = Object.assign(new Error('Service Unavailable'), { statusCode });
      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' },
        gateway: {
          getEmailDraft: vi.fn().mockRejectedValue(err),
          sendEmailDraft: vi.fn(),
          listAccountIds: vi.fn().mockReturnValue(['curia']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/transient/i);
    });

    it('explains a draft in none of Curia\'s accounts and points at email-send', async () => {
      // A ceo-inbox draft lives in the principal's Gmail, outside every Curia account.
      const ctx = makeCtx({
        input: { draft_id: 'r956985379676630908' },
        gateway: {
          getEmailDraft: vi.fn().mockResolvedValue(null),
          sendEmailDraft: vi.fn(),
          listAccountIds: vi.fn().mockReturnValue(['curia']),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/not found/i);
        expect(result.error).toContain("Drafts in the principal's own mailbox aren't in Curia's accounts");
        expect(result.error).toContain('the ceo-inbox specialist sends those');
        expect(result.error).not.toContain('email-send');
        expect(result.error).toMatch(/do not retry/i);
        expect(result.error).not.toMatch(/transient/i);
      }
    });

    it('returns error when no email accounts are configured', async () => {
      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123' }, // no account
        gateway: {
          getEmailDraft: vi.fn(),
          sendEmailDraft: vi.fn(),
          listAccountIds: vi.fn().mockReturnValue([]),
        },
      });

      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no email accounts/i);
    });

    it('uses explicit account when provided (fast path)', async () => {
      // When account is provided, only that account is searched — not all accounts.
      const getEmailDraft = vi.fn().mockResolvedValue(DRAFT_STUB);
      const sendEmailDraft = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
      const listAccountIds = vi.fn().mockReturnValue(['curia', 'personal']);

      const ctx = makeCtx({
        input: { draft_id: 'draft-abc123', account: 'personal' },
        gateway: { getEmailDraft, sendEmailDraft, listAccountIds },
      });

      await handler.execute(ctx);

      // listAccountIds should NOT be called — fast path skips the iteration
      expect(listAccountIds).not.toHaveBeenCalled();
      // getEmailDraft called once with 'personal' specifically
      expect(getEmailDraft).toHaveBeenCalledWith('draft-abc123', 'personal');
    });
  });

  // ─── action_log transition on approval ───────────────────────────────────

  describe('action_log transition on approval', () => {
    it('transitions matching action_log row to approved on successful send', async () => {
      // Arrange: actionLogRepo finds a matching pending row for the draft
      const mockRow = { id: 55 };
      const findPendingByPayloadField = vi.fn().mockResolvedValue(mockRow);
      const resolveById = vi.fn().mockResolvedValue(true);
      const ctx = makeCtx({
        actionLogRepo: { findPendingByPayloadField, resolveById },
      });

      // Act
      const result = await handler.execute(ctx);

      // Assert: send succeeded and action_log was transitioned
      expect(result.success).toBe(true);
      expect(findPendingByPayloadField).toHaveBeenCalledWith('draft_id', 'draft-abc123');
      expect(resolveById).toHaveBeenCalledWith(55, 'approved', 'coordinator');
    });

    it('still succeeds when no action_log row exists (pre-existing draft)', async () => {
      // findPendingByPayloadField returns null — draft was not created via the autonomy gate
      const findPendingByPayloadField = vi.fn().mockResolvedValue(null);
      const resolveById = vi.fn();
      const ctx = makeCtx({
        actionLogRepo: { findPendingByPayloadField, resolveById },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      // resolveById must NOT be called when no row was found
      expect(resolveById).not.toHaveBeenCalled();
    });

    it('still succeeds when actionLogRepo is not available', async () => {
      // No actionLogRepo in ctx — older code paths, or skills without the capability
      const ctx = makeCtx({ actionLogRepo: null });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
    });

    // Sending the draft of a personal-data ask is the principal's yes, as approve-action records
    // it (#2312), but only from a live principal turn whose approval was delivered: a yes covers
    // the whole thread, and principal lineage alone also passes a woken task.
    describe('a row carrying a personal-data ask', () => {
      const disclosureAsk = { conversationId: 'conv-1', counterparties: ['joel@example.com'], labels: ['sin_ca'], requester: 'joel@example.com', outreachId: 'o-1' };
      const delivered = { id: 55, shortRef: 'ab12cd34', disclosureAsk, notificationSentAt: new Date('2026-10-26T10:00:00Z') };
      const undelivered = { ...delivered, notificationSentAt: null };
      const run = async (row: Record<string, unknown>, opts: { liveTurn?: boolean; resolved?: boolean; recorder?: boolean } = {}) => {
        const recordForApproval = vi.fn().mockResolvedValue(undefined);
        const resolveById = vi.fn().mockResolvedValue(opts.resolved ?? true);
        const ctx = makeCtx({
          actionLogRepo: { findPendingByPayloadField: vi.fn().mockResolvedValue(row), resolveById },
          ...(opts.recorder === false ? {} : { disclosureDecisions: { recordForApproval } }),
          ...(opts.liveTurn !== undefined ? { liveTurn: opts.liveTurn } : {}),
        });
        const result = await handler.execute(ctx);
        return { result, recordForApproval, resolveById };
      };

      it('records the yes from a live principal turn on a delivered approval', async () => {
        const { result, recordForApproval } = await run(delivered, { liveTurn: true });
        expect(result.success).toBe(true);
        expect(recordForApproval).toHaveBeenCalledWith(delivered, 'yes', 'principal_via_coordinator');
      });

      it('records nothing from a woken principal-lineage task, but still sends and resolves the row', async () => {
        for (const liveTurn of [false, undefined]) {
          const { result, recordForApproval, resolveById } = await run(delivered, liveTurn === undefined ? {} : { liveTurn });
          expect(result.success).toBe(true);
          expect(resolveById).toHaveBeenCalledWith(55, 'approved', 'coordinator');
          expect(recordForApproval).not.toHaveBeenCalled();
        }
      });

      it('records nothing for an approval the principal was never shown', async () => {
        const { result, recordForApproval } = await run(undelivered, { liveTurn: true });
        expect(result.success).toBe(true);
        expect(recordForApproval).not.toHaveBeenCalled();
      });

      it('records nothing when the row was resolved concurrently, or carries no ask', async () => {
        expect((await run(delivered, { liveTurn: true, resolved: false })).recordForApproval).not.toHaveBeenCalled();
        expect((await run({ ...delivered, disclosureAsk: null }, { liveTurn: true })).recordForApproval).not.toHaveBeenCalled();
      });

      it('still sends when the recorder is not wired', async () => {
        expect((await run(delivered, { liveTurn: true, recorder: false })).result.success).toBe(true);
      });
    });

    it('still succeeds when action_log transition throws', async () => {
      // Best-effort: failure in the action_log path must not fail the skill —
      // the email has already been sent at this point.
      const findPendingByPayloadField = vi.fn().mockRejectedValue(new Error('DB error'));
      const ctx = makeCtx({
        actionLogRepo: { findPendingByPayloadField, resolveById: vi.fn() },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
    });
  });
});
