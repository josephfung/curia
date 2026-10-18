import { describe, it, expect, vi } from 'vitest';
import { ReportToPrincipalHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { PrincipalReportEvent } from '../../../../src/bus/events.js';
import { createSilentLogger } from '../../../../src/logger.js';

function makeCtx(input: Record<string, unknown>, overrides?: Partial<ToolContext>): ToolContext {
  return {
    input,
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    taskEventId: 'task-1',
    conversationId: 'email:thread-1',
    bus: { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus,
    ...overrides,
  } as ToolContext;
}

describe('ReportToPrincipalHandler', () => {
  it('publishes one digest item from the dispatch layer', async () => {
    const ctx = makeCtx({ summary: 'Confirmed Tuesday 2pm with Dana.' });

    const result = await new ReportToPrincipalHandler().execute(ctx);

    expect(result.success).toBe(true);
    const publish = ctx.bus!.publish as ReturnType<typeof vi.fn>;
    expect(publish).toHaveBeenCalledTimes(1);
    const [layer, event] = publish.mock.calls[0]! as [string, PrincipalReportEvent];
    expect(layer).toBe('dispatch');
    expect(event.type).toBe('principal.report');
    expect(event.parentEventId).toBe('task-1');
    expect(event.payload).toEqual({
      summary: 'Confirmed Tuesday 2pm with Dana.',
      urgency: 'digest',
      source: 'agent',
      conversationId: 'email:thread-1',
    });
  });

  it('passes urgency now and a link through', async () => {
    const ctx = makeCtx({ summary: 'Paid the invoice.', urgency: 'now', link: 'https://example.com/t/1' });

    await new ReportToPrincipalHandler().execute(ctx);

    const event = (ctx.bus!.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1] as PrincipalReportEvent;
    expect(event.payload.urgency).toBe('now');
    expect(event.payload.link).toBe('https://example.com/t/1');
  });

  it('rejects an empty or over-long summary and an unknown urgency', async () => {
    const handler = new ReportToPrincipalHandler();
    expect((await handler.execute(makeCtx({ summary: '  ' }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ summary: 'x'.repeat(501) }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ summary: 'ok', urgency: 'later' }))).success).toBe(false);
  });

  it('fails without a bus or a task event id', async () => {
    const handler = new ReportToPrincipalHandler();
    expect((await handler.execute(makeCtx({ summary: 'ok' }, { bus: undefined }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ summary: 'ok' }, { taskEventId: undefined }))).success).toBe(false);
  });

  it('returns an error, not a throw, when publish fails', async () => {
    const ctx = makeCtx({ summary: 'ok' }, {
      bus: { publish: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as EventBus,
    });

    const result = await new ReportToPrincipalHandler().execute(ctx);

    expect(result.success).toBe(false);
  });
});
