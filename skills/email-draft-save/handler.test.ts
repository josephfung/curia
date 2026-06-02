// handler.test.ts — unit tests for email-draft-save skill.

import { describe, it, expect, vi } from 'vitest';
import { EmailDraftSaveHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import { createSilentLogger } from '../../src/logger.js';

// --- Shared test helpers ---

const BASE_INPUT = {
  to: 'alice@example.com',
  subject: 'Hello',
  body: 'Hi there',
  account: 'ceo',
};

// A mock outboundGateway that returns a successful draft creation result
function makeMockGateway(overrides?: { createEmailDraft?: ReturnType<typeof vi.fn> }) {
  return {
    createEmailDraft: overrides?.createEmailDraft
      ?? vi.fn().mockResolvedValue({ success: true, draftId: 'draft-abc' }),
    // Other gateway methods are not used by this skill — typed as unknown
  } as unknown as SkillContext['outboundGateway'];
}

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: BASE_INPUT,
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    outboundGateway: makeMockGateway(),
    taskMetadata: {},
    taskEventId: undefined,
    ...overrides,
  } as SkillContext;
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
    const handler = new EmailDraftSaveHandler();
    const result = await handler.execute(makeCtx());
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data).toEqual({ draft_id: 'draft-abc' });
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
