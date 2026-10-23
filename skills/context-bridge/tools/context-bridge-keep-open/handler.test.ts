import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { AgentRegistry } from '../../../../src/agents/agent-registry.js';
import { ContextBridgeKeepOpenHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const handler = new ContextBridgeKeepOpenHandler();
const ENTRY_ID = '00000000-0000-4000-8000-000000000002';

/** A delegated specialist's ctx: delegate stamps delegationOrigin on every delegated task. */
/** The roster ownership is resolved against (#1972). */
const agentRegistry = new AgentRegistry();
agentRegistry.register('coordinator', { role: 'coordinator', description: 'router' });
agentRegistry.register('ceo-inbox', { role: 'specialist', description: 'inbox' });
agentRegistry.register('calendar', { role: 'specialist', description: 'calendar' });
agentRegistry.register('research-analyst', { role: 'specialist', description: 'research' });

function makeCtx(input: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    agentRegistry,
    log: pino({ level: 'silent' }),
    agentId: 'ceo-inbox',
    taskEventId: 'task-delegated-1',
    taskMetadata: { delegationOrigin: { agentId: 'coordinator', conversationId: 'signal:+1555' } },
    outboundContext: {
      getEntry: vi.fn().mockResolvedValue({ id: ENTRY_ID, delegationHint: 'ceo-inbox', metadata: null }),
      markExchangeOpen: vi.fn().mockResolvedValue(true),
    },
    ...overrides,
  } as unknown as ToolContext;
}

describe('ContextBridgeKeepOpenHandler (#1972)', () => {
  it('marks the entry open for this delegated task', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID, reason: 'asked which day suits' });
    const result = await handler.execute(ctx);
    expect(result).toEqual({ success: true, data: { kept_open: ENTRY_ID } });
    expect(ctx.outboundContext!.markExchangeOpen).toHaveBeenCalledWith(ENTRY_ID, {
      agentId: 'ceo-inbox',
      taskEventId: 'task-delegated-1',
      reason: 'asked which day suits',
    });
  });

  it('refuses outside a delegated task — there is no delegation return to hold the release for', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID }, { taskMetadata: {} });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/delegated/);
    expect(ctx.outboundContext!.markExchangeOpen).not.toHaveBeenCalled();
  });

  it('refuses an entry another agent owns', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    (ctx.outboundContext!.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ENTRY_ID, delegationHint: 'calendar', metadata: null,
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('calendar');
    expect(ctx.outboundContext!.markExchangeOpen).not.toHaveBeenCalled();
  });

  it('accepts an entry with no hint — the delegate brief linked it to this specialist', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    (ctx.outboundContext!.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ENTRY_ID, delegationHint: null, metadata: null,
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });

  it('reports a missing or released entry rather than claiming it was kept', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    (ctx.outboundContext!.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found or already released/);
  });

  it('reports a mark that matched no active row (released while this ran)', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    (ctx.outboundContext!.markExchangeOpen as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID entry_id before querying', async () => {
    const ctx = makeCtx({ entry_id: 'dana-thread' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(ctx.outboundContext!.getEntry).not.toHaveBeenCalled();
  });

  it('returns an error when the store throws', async () => {
    const ctx = makeCtx({ entry_id: ENTRY_ID });
    (ctx.outboundContext!.markExchangeOpen as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/db down/);
  });

  // #2261: a delegation a contact's turn started carries their originator; only an entry
  // sent to them can be kept open.
  describe('in a delegation an outside contact\'s turn started', () => {
    const XIAOPU = '1d833dd7-5c5f-4adc-b311-c8347b49a18e';
    const taskMetadata = {
      delegationOrigin: { agentId: 'coordinator', conversationId: 'signal:+1555' },
      originator: { contactId: XIAOPU, systemRole: null, channel: 'signal', initiatedAt: '2026-10-21T21:29:59.973Z', tier: 'trusted' },
    };
    const withEntry = (recipientContactIds: string[] | null) => makeCtx({ entry_id: ENTRY_ID }, {
      taskMetadata,
      outboundContext: {
        getEntry: vi.fn().mockResolvedValue({ id: ENTRY_ID, delegationHint: 'ceo-inbox', metadata: null, recipientContactIds }),
        markExchangeOpen: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Partial<ToolContext>);

    it.each([
      ['sent to someone else', ['6e99314b-f9b5-4515-bafb-1a52d45b706b']],
      ['with no recipients', null],
    ])('refuses an entry %s', async (_label, recipients) => {
      const ctx = withEntry(recipients);
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      expect(ctx.outboundContext!.markExchangeOpen).not.toHaveBeenCalled();
    });

    it('keeps open an entry sent to that contact', async () => {
      const ctx = withEntry([XIAOPU]);
      const result = await handler.execute(ctx);
      expect(result).toEqual({ success: true, data: { kept_open: ENTRY_ID } });
    });
  });
});
