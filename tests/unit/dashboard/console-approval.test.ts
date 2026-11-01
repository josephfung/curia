import { describe, expect, it, vi } from 'vitest';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import { RESOLVED_BY } from '../../../src/autonomy/action-log-types.js';
import { approveFromConsole, denyFromConsole, type ConsoleApprovalDeps } from '../../../src/dashboard/console-approval.js';
import type { DisclosureAsk } from '../../../src/autonomy/disclosure-decisions.js';
import { createSilentLogger } from '../../../src/logger.js';

function row(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 7,
    taskId: '11111111-1111-1111-1111-111111111111',
    conversationId: null,
    toolName: 'send-draft',
    actionRisk: 'medium',
    outcome: 'pending_approval',
    taskSummary: null,
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: { draft_id: 'draft-1', account: 'ops', subject: 'Renewal' },
    notificationSentAt: new Date('2026-10-28T12:00:00.000Z'),
    resolvedAt: null,
    resolvedBy: null,
    // Relative to the real clock: approve/deny default `now` to new Date(), so a fixed
    // date here expired the fixture once the calendar passed it (2026-11-01).
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    parentActionId: null,
    shortRef: 'abc',
    approvalNumber: 3,
    description: 'Reply to vendor',
    createdAt: new Date('2026-10-28T10:00:00.000Z'),
    ...overrides,
  };
}

function deps(overrides: Partial<ConsoleApprovalDeps> = {}): ConsoleApprovalDeps & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    actionLogRepo: {
      resolveRow: vi.fn(async () => {
        order.push('resolve');
        return true;
      }),
      rejectStaleApproval: vi.fn(async () => true),
      insert: vi.fn(async () => 1),
    },
    executionLayer: {
      invoke: vi.fn(async () => {
        order.push('invoke');
        return { success: true as const, data: {} };
      }),
      confirmPinnedSendResolution: vi.fn(async () => ({ ok: true as const })),
    },
    deleteMailboxDraft: vi.fn(async () => {
      order.push('delete');
    }),
    principalContactId: 'principal-1',
    logger: createSilentLogger(),
    ...overrides,
  };
}

describe('denyFromConsole', () => {
  it('deletes the mailbox draft and never runs the tool', async () => {
    const d = deps();
    const result = await denyFromConsole(row(), d);
    expect(result).toEqual({ ok: true, sent: false });
    expect(d.order).toEqual(['delete', 'resolve']);
    expect(d.executionLayer!.invoke).not.toHaveBeenCalled();
    expect(d.actionLogRepo.resolveRow).toHaveBeenCalledWith(7, 'denied', RESOLVED_BY.console);
    expect(d.deleteMailboxDraft).toHaveBeenCalledWith('ops', 'draft-1');
  });

  it('forwards an omitted account so the deleter can search every mailbox', async () => {
    const d = deps();
    const result = await denyFromConsole(row({ payload: { draft_id: 'draft-9' } }), d);
    expect(result).toEqual({ ok: true, sent: false });
    expect(d.deleteMailboxDraft).toHaveBeenCalledWith(undefined, 'draft-9');
  });

  it('leaves the row pending when the draft delete fails', async () => {
    const d = deps({
      deleteMailboxDraft: vi.fn(async () => {
        throw new Error('nylas down');
      }),
    });
    const result = await denyFromConsole(row(), d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
    expect(d.actionLogRepo.resolveRow).not.toHaveBeenCalled();
    expect(d.executionLayer!.invoke).not.toHaveBeenCalled();
  });
});

describe('approveFromConsole', () => {
  it('resolves as console and re-runs the blocked tool', async () => {
    const d = deps();
    const result = await approveFromConsole(row({ toolName: 'email-send', payload: { subject: 'Hi' } }), d);
    expect(result).toEqual({ ok: true, sent: true });
    expect(d.order).toEqual(['resolve', 'invoke']);
    expect(d.deleteMailboxDraft).not.toHaveBeenCalled();
    expect(d.actionLogRepo.resolveRow).toHaveBeenCalledWith(7, 'approved', RESOLVED_BY.console);
    expect(d.executionLayer!.invoke).toHaveBeenCalledWith(
      'email-send',
      { subject: 'Hi' },
      { contactId: 'principal-1', role: 'ceo', channel: 'web' },
      expect.objectContaining({
        humanApproved: true,
        taskEventId: row().taskId,
        taskMetadata: {
          originator: expect.objectContaining({ contactId: 'principal-1', channel: 'web', systemRole: 'principal' }),
        },
      }),
    );
  });

  it('tells the principal to review, and approves once the console has shown the item', async () => {
    const ask: DisclosureAsk = {
      conversationId: 'conv',
      counterparties: ['ada@example.com'],
      labels: ['email'],
      requester: 'ada@example.com',
    };
    const held = row({
      toolName: 'email-send',
      payload: { to: 'ada@example.com', subject: 'Hi', body: 'Hello' },
      notificationSentAt: null,
      disclosureAsk: ask,
    });
    const hidden = await approveFromConsole(held, deps());
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) {
      expect(hidden.status).toBe(409);
      expect(hidden.error).toMatch(/Review this item/);
      expect(hidden.error).not.toMatch(/deliver-approval/);
    }
    const shown = await approveFromConsole(held, deps(), new Date(), { shown: true });
    expect(shown).toEqual({ ok: true, sent: true });
  });

  it('will not approve a send-draft until the mailbox copy is loaded, and still runs the original payload', async () => {
    const bare = row({ payload: { draft_id: 'draft-1' }, notificationSentAt: new Date() });
    const missing = await approveFromConsole(bare, deps(), new Date(), { shown: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/could not be loaded/);

    const d = deps({
      loadHeldDraft: async () => ({
        account: 'personal',
        to: 'ada@example.com',
        cc: '',
        subject: 'Board notes',
        body: 'See you Thursday.',
      }),
    });
    const result = await approveFromConsole(bare, d, new Date(), { shown: true });
    expect(result).toEqual({ ok: true, sent: true });
    expect(d.executionLayer!.invoke).toHaveBeenCalledWith(
      'send-draft',
      { draft_id: 'draft-1' },
      expect.anything(),
      expect.objectContaining({ humanApproved: true }),
    );
  });

  it('does not re-run when the row was already resolved', async () => {
    const d = deps();
    d.actionLogRepo.resolveRow = vi.fn(async () => false);
    const result = await approveFromConsole(row({ toolName: 'email-send', payload: { subject: 'Hi' } }), d);
    expect(result.ok).toBe(false);
    expect(d.executionLayer!.invoke).not.toHaveBeenCalled();
  });
});
