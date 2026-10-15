// Shared fixtures for the bullpen bundle's handler tests.

import { vi } from 'vitest';
import { BullpenService } from '../../src/memory/bullpen.js';
import { createLogger } from '../../src/logger.js';
import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import { BullpenPostHandler } from '../bullpen/tools/bullpen-post/handler.js';

export function makeCtx(input: Record<string, unknown>, overrides?: Partial<ToolContext>): ToolContext {
  const bullpenService = BullpenService.createInMemory();
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: createLogger('error'),
    agentId: 'coordinator',
    taskEventId: 'task-123',
    bullpenService,
    // bus is needed to publish agent.discuss — use a spy
    bus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as ToolContext['bus'],
    // Default stub accepts every name so existing posts stay focused on routing.
    // The unknown-participant test overrides this with a real registry.
    agentRegistry: {
      has: () => true,
      list: () => [],
    } as unknown as ToolContext['agentRegistry'],
    ...overrides,
  } as unknown as ToolContext;
}

/** A context whose log.warn is a spy, for the #1828 recurrence signal. */
export function makeCtxWithWarn(
  input: Record<string, unknown>,
  overrides?: Partial<ToolContext>,
): { ctx: ToolContext; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const baseLog = createLogger('error');
  const ctx = makeCtx(input, {
    ...overrides,
    log: { ...baseLog, warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
  });
  return { ctx, warn };
}

export function dataOf(result: ToolResult): Record<string, unknown> {
  if (!result.success) throw new Error(`expected success, got: ${result.error}`);
  return result.data as Record<string, unknown>;
}

export function errorOf(result: ToolResult): string {
  if (result.success) throw new Error('expected a failure');
  return result.error;
}

/**
 * Open a thread with bullpen-post and return its id plus the context it used, so a
 * test can act on the thread with the same service and bus.
 */
export async function openThread(
  input: Record<string, unknown>,
  overrides?: Partial<ToolContext>,
): Promise<{ threadId: string; ctx: ToolContext }> {
  const ctx = makeCtx(input, overrides);
  const threadId = dataOf(await new BullpenPostHandler().execute(ctx)).thread_id as string;
  return { threadId, ctx };
}

/** The publish spy's calls on a context made by makeCtx. */
export function publishCalls(ctx: ToolContext): unknown[][] {
  return (ctx.bus!.publish as ReturnType<typeof vi.fn>).mock.calls;
}

/** JOB_ID / RUN_CONV: a scheduled run whose job id a model passes as thread_id (#1828). */
export const JOB_ID = 'd3f8bfa9-1761-4f01-a66e-a3d4c28834b0';
export const RUN_CONV = `scheduler:${JOB_ID}:run-xyz`;
