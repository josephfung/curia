import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { ActionLogRepo } from '../../../../src/autonomy/action-log-repo.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { SpotCheckSamplerDeps } from '../../../../src/reports/spot-check-sampler.js';
import { createSilentLogger } from '../../../../src/logger.js';

// The sampler has its own unit tests; here it is stubbed so the handler's wiring is what is tested.
const sampler = vi.hoisted(() => ({
  draw: vi.fn<(conversationId: string) => Promise<{ block: string; count: number } | null>>(),
  deps: [] as unknown[],
}));
vi.mock('../../../../src/reports/spot-check-sampler.js', () => ({
  SpotCheckSampler: class {
    constructor(deps: unknown) { sampler.deps.push(deps); }
    draw(conversationId: string) { return sampler.draw(conversationId); }
  },
}));

const { ListSpotChecksHandler } = await import('./handler.js');

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    input: {},
    secret: () => { throw new Error('no secrets'); },
    log: createSilentLogger(),
    conversationId: 'scheduler:job1:run1',
    actionLogRepo: { findSampleCandidates: vi.fn(), markSampled: vi.fn() } as unknown as ActionLogRepo,
    entityMemory: { findEntities: vi.fn(), getFacts: vi.fn(), storeFact: vi.fn() } as unknown as EntityMemory,
    ...over,
  } as unknown as ToolContext;
}

beforeEach(() => {
  sampler.draw.mockReset();
  sampler.deps.length = 0;
});

describe('ListSpotChecksHandler', () => {
  it('passes the drawn block through, drawn for this conversation', async () => {
    const block = 'Spot check (optional, reply with a number):\n1. Archive an email';
    sampler.draw.mockResolvedValue({ block, count: 1 });

    const result = await new ListSpotChecksHandler().execute(makeCtx());

    expect(result).toEqual({ success: true, data: { block, count: 1 } });
    expect(sampler.draw).toHaveBeenCalledWith('scheduler:job1:run1');
  });

  it('returns a null block and a zero count when there is nothing to check', async () => {
    sampler.draw.mockResolvedValue(null);

    const result = await new ListSpotChecksHandler().execute(makeCtx());

    expect(result).toEqual({ success: true, data: { block: null, count: 0 } });
  });

  it.each([
    ['actionLogRepo', /actionLogRepo/],
    ['entityMemory', /entityMemory/],
    ['conversationId', /conversation/],
  ] as const)('fails without %s', async (field, message) => {
    const result = await new ListSpotChecksHandler().execute(makeCtx({ [field]: undefined }));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(message);
    expect(sampler.draw).not.toHaveBeenCalled();
  });

  it('wires no email lookup when there is no outbound gateway', async () => {
    sampler.draw.mockResolvedValue(null);

    await new ListSpotChecksHandler().execute(makeCtx());

    expect((sampler.deps[0] as SpotCheckSamplerDeps).describeEmail).toBeUndefined();
  });

  it('describes a triage email from the outbound gateway as subject and "Name <email>"', async () => {
    sampler.draw.mockResolvedValue(null);
    const getEmailMessage = vi.fn()
      .mockResolvedValueOnce({ subject: 'Q4 board deck', from: [{ name: 'Priya Shah', email: 'priya@example.com' }] })
      .mockResolvedValueOnce({ subject: '', from: [{ email: 'sam@example.com' }] })
      .mockResolvedValueOnce({ subject: 'No sender', from: [] });
    const outboundGateway = { getEmailMessage } as unknown as OutboundGateway;

    await new ListSpotChecksHandler().execute(makeCtx({ outboundGateway }));
    const describeEmail = (sampler.deps[0] as SpotCheckSamplerDeps).describeEmail!;

    expect(await describeEmail('msg-1', 'work')).toEqual({ subject: 'Q4 board deck', from: 'Priya Shah <priya@example.com>' });
    expect(getEmailMessage).toHaveBeenCalledWith('msg-1', 'work');
    expect(await describeEmail('msg-2')).toEqual({ subject: undefined, from: 'sam@example.com' });
    expect(await describeEmail('msg-3')).toEqual({ subject: 'No sender', from: undefined });
  });
});
