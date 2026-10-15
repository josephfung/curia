import { describe, it, expect, vi } from 'vitest';
import { BullpenPostHandler } from './handler.js';
import { BullpenService } from '../../../../src/memory/bullpen.js';
import { AgentRegistry } from '../../../../src/agents/agent-registry.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { dataOf, errorOf, makeCtx, publishCalls } from '../../../_shared/bullpen-test-helpers.js';

const handler = new BullpenPostHandler();

describe('bullpen-post', () => {
  it('opens a thread and publishes agent.discuss', async () => {
    const ctx = makeCtx({
      topic: 'Q2 budget',
      participants: ['coordinator', 'research-agent'],
      content: 'Can you look into Q2 costs?',
      mentioned_agent_ids: ['research-agent'],
    });
    const data = dataOf(await handler.execute(ctx));
    expect(typeof data.thread_id).toBe('string');
    expect(typeof data.message_id).toBe('string');
    expect(data.deduplicated).toBe(false);
    expect(ctx.bus!.publish).toHaveBeenCalledOnce();
    const publishCall = publishCalls(ctx)[0]! as [string, { type: string; payload: Record<string, unknown> }];
    expect(publishCall[0]).toBe('agent');
    expect(publishCall[1].type).toBe('agent.discuss');
    expect(publishCall[1].payload.threadClosed).toBeUndefined();
  });

  it('rejects a participant that is not a known agent and names the valid ones (#1898)', async () => {
    const registry = new AgentRegistry();
    registry.register('coordinator', { role: 'coordinator', description: 'Coordinator' });
    registry.register('research-agent', { role: 'specialist', description: 'Research' });
    const ctx = makeCtx({
      topic: 'Q2 budget',
      participants: ['coordinator', 'T2125-expense-tracker'],
      content: 'Can you look into Q2 costs?',
    }, { agentRegistry: registry });
    const error = errorOf(await handler.execute(ctx));
    expect(error).toContain('T2125-expense-tracker');
    expect(error).toContain('coordinator');
    expect(error).toContain('research-agent');
    expect(ctx.bus!.publish).not.toHaveBeenCalled();
  });

  it('defaults mentionedAgentIds to all participants when omitted', async () => {
    const ctx = makeCtx({
      topic: 'Broadcast',
      participants: ['coordinator', 'agent-b', 'agent-c'],
      content: 'Heads up',
    });
    expect((await handler.execute(ctx)).success).toBe(true);
    const publishCall = publishCalls(ctx)[0]! as [string, { payload: Record<string, unknown> }];
    expect(publishCall[1].payload.mentionedAgentIds).toEqual(['coordinator', 'agent-b', 'agent-c']);
  });

  it.each([
    [{ participants: ['agent-b'], content: 'x' }, "Missing required field: 'topic'"],
    [{ topic: 't', content: 'x' }, "Missing required field: 'participants' (non-empty string array)"],
    [{ topic: 't', participants: [], content: 'x' }, "Missing required field: 'participants' (non-empty string array)"],
    [{ topic: 't', participants: ['agent-b'] }, "Missing required field: 'content'"],
    [{ topic: 't', participants: ['agent-b'], content: '' }, "Missing required field: 'content'"],
  ])('refuses %j with the missing field named', async (input, expected) => {
    const ctx = makeCtx(input);
    expect(errorOf(await handler.execute(ctx))).toBe(expected);
    expect(ctx.bus!.publish).not.toHaveBeenCalled();
  });

  // Regression test for #721: bus.publish awaits subscribers sequentially
  // (see src/bus/bus.ts), so a slow agent.discuss subscriber would block
  // bullpen-post past its 10s skill timeout — even though the thread row was
  // already committed. The handler must return as soon as openThread commits;
  // publish is fire-and-forget per the handler comments.
  it('returns immediately even when bus.publish is slow', async () => {
    let publishResolve: (() => void) | undefined;
    const slowPublish = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { publishResolve = resolve; }),
    );
    const ctx = makeCtx(
      {
        topic: 'slow subscriber',
        participants: ['coordinator', 'agent-b'],
        content: 'Should not block',
      },
      {
        bus: {
          publish: slowPublish,
          subscribe: vi.fn(),
        } as unknown as ToolContext['bus'],
      },
    );

    const start = Date.now();
    const result = await handler.execute(ctx);
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    // Publish is still in-flight, but handler returned without awaiting it.
    expect(slowPublish).toHaveBeenCalledOnce();
    expect(publishResolve).toBeDefined();
    // Generous upper bound — openThread is in-memory, should be milliseconds.
    expect(elapsed).toBeLessThan(500);

    // Cleanup so the dangling promise doesn't keep vitest open.
    publishResolve!();
  });

  it('returns the existing thread when source_message_id matches a prior post', async () => {
    const input = {
      topic: 'expense receipt',
      participants: ['coordinator', 't2125-expense-tracker'],
      content: 'Please process this receipt',
      source_message_id: 'email-msg-abc123',
    };
    const ctx = makeCtx(input);
    const firstData = dataOf(await handler.execute(ctx));

    // Second post with the same source_message_id — simulates a duplicate ceo-inbox run
    const ctx2 = makeCtx(input, { bullpenService: ctx.bullpenService, bus: ctx.bus });
    const secondData = dataOf(await handler.execute(ctx2));

    // Must return the same thread — no new thread opened
    expect(secondData.thread_id).toBe(firstData.thread_id);
    // Dedup flag must be set
    expect(secondData.deduplicated).toBe(true);
    // Bus publish called exactly once — no duplicate agent.discuss event
    expect(publishCalls(ctx)).toHaveLength(1);
  });

  it('concurrent duplicate posts (23505 race) — one thread, one publish', async () => {
    // Two handler.execute calls race with the same source_message_id on a shared
    // bullpenService. The in-memory backend mirrors Postgres by throwing code
    // '23505' when the duplicate insert arrives. BullpenService.openThread catches
    // that, re-fetches the winning thread, and returns deduplicated: true — so the
    // handler skips the second bus.publish.
    const bullpenService = BullpenService.createInMemory();
    const bus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as ToolContext['bus'];

    const makeRaceCtx = () => makeCtx(
      {
        topic: 'concurrent topic',
        participants: ['coordinator', 'agent-b'],
        content: 'racing message',
        source_message_id: 'email-race-concurrent',
      },
      { bullpenService, bus },
    );

    const [r1, r2] = await Promise.all([
      handler.execute(makeRaceCtx()),
      handler.execute(makeRaceCtx()),
    ]);

    const d1 = dataOf(r1);
    const d2 = dataOf(r2);
    // Both must reference the same winning thread
    expect(d1.thread_id).toBe(d2.thread_id);
    // Exactly one call was marked as a dedup hit
    expect([d1.deduplicated, d2.deduplicated].filter(Boolean)).toHaveLength(1);
    // bus.publish fired exactly once — no duplicate agent.discuss
    expect((bus!.publish as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('a publish rejection does not surface as a handler failure', async () => {
    const failingPublish = vi.fn().mockRejectedValue(new Error('bus exploded'));
    const ctx = makeCtx(
      {
        topic: 'publish fail',
        participants: ['coordinator'],
        content: 'still ok',
      },
      {
        bus: { publish: failingPublish, subscribe: vi.fn() } as unknown as ToolContext['bus'],
      },
    );

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // Let the rejected promise settle so the .catch() runs before the test
    // exits — otherwise vitest may flag an unhandled rejection.
    await new Promise((r) => setImmediate(r));
    expect(failingPublish).toHaveBeenCalledOnce();
  });

  it('refuses before validating when the bullpen service is absent', async () => {
    const ctx = makeCtx({}, { bullpenService: undefined });
    expect(errorOf(await handler.execute(ctx))).toBe('BullpenService not available in context');
  });
});
