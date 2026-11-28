import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { ActionLogRepo } from '../../../../src/autonomy/action-log-repo.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { DrawResult, SpotCheckSamplerDeps } from '../../../../src/reports/spot-check-sampler.js';
import { createSilentLogger } from '../../../../src/logger.js';
import { sanitizeObjectOutput } from '../../../../src/skills/sanitize.js';

// The sampler has its own unit tests; here it is stubbed so the handler's wiring is what is tested.
const sampler = vi.hoisted(() => ({
  draw: vi.fn<(conversationId: string) => Promise<DrawResult>>(),
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
    sampler.draw.mockResolvedValue({ kind: 'drawn', block, count: 1, setId: 'set-1' });

    const result = await new ListSpotChecksHandler().execute(makeCtx());

    // No setId and no action ids: the agent sees the block and its size only.
    expect(result).toEqual({ success: true, data: { block, count: 1 } });
    expect(sampler.draw).toHaveBeenCalledWith('scheduler:job1:run1');
  });

  // The reason tells "nothing to check" apart from "the spot-check pipeline is broken".
  it.each([
    [{ kind: 'empty' }, 'empty'],
    [{ kind: 'unavailable', reason: 'store_rejected' }, 'store_rejected'],
    [{ kind: 'unavailable', reason: 'error' }, 'error'],
  ] as const)('returns a null block, a zero count and the reason when nothing was drawn (%o)', async (drawn, reason) => {
    sampler.draw.mockResolvedValue(drawn);

    const result = await new ListSpotChecksHandler().execute(makeCtx());

    expect(result).toEqual({ success: true, data: { block: null, count: 0, reason } });
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
    sampler.draw.mockResolvedValue({ kind: 'empty' });

    await new ListSpotChecksHandler().execute(makeCtx());

    expect((sampler.deps[0] as SpotCheckSamplerDeps).describeEmail).toBeUndefined();
  });

  it('describes a triage email from the outbound gateway as subject and "Name (email)"', async () => {
    sampler.draw.mockResolvedValue({ kind: 'empty' });
    const getEmailMessage = vi.fn()
      .mockResolvedValueOnce({ subject: 'Q4 board deck', from: [{ name: 'Priya Shah', email: 'priya@example.com' }] })
      .mockResolvedValueOnce({ subject: '', from: [{ email: 'sam@example.com' }] })
      .mockResolvedValueOnce({ subject: 'No sender', from: [] });
    const outboundGateway = { getEmailMessage } as unknown as OutboundGateway;

    await new ListSpotChecksHandler().execute(makeCtx({ outboundGateway }));
    const describeEmail = (sampler.deps[0] as SpotCheckSamplerDeps).describeEmail!;

    const described = await describeEmail('msg-1', 'work');
    expect(described).toEqual({ subject: 'Q4 board deck', from: 'Priya Shah (priya@example.com)' });
    // The block reaches the digest through sanitizeObjectOutput, which strips "<...>" as a tag.
    expect(sanitizeObjectOutput(described)).toEqual(described);
    expect(getEmailMessage).toHaveBeenCalledWith('msg-1', 'work');
    expect(await describeEmail('msg-2')).toEqual({ subject: undefined, from: 'sam@example.com' });
    expect(await describeEmail('msg-3')).toEqual({ subject: 'No sender', from: undefined });
  });
});

describe('ListSpotChecksHandler — outside contacts (#1320)', () => {
  const OUTSIDER = { originator: { contactId: 'dana-contact', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known' } };

  it('refuses a task an outside contact started, and draws nothing', async () => {
    const result = await new ListSpotChecksHandler().execute(makeCtx({ taskMetadata: OUTSIDER } as Partial<ToolContext>));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/principal/);
    expect(sampler.draw).not.toHaveBeenCalled();
  });
});
