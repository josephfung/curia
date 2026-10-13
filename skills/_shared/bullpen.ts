// bullpen.ts — shared core for the bullpen bundle's tools (#2126).
//
// bullpen-post, bullpen-reply, bullpen-read and bullpen-close each take only their
// own fields, so each schema can mark those fields required. They share the context
// guard, the agent-facing thread-miss copy and the catch remapper below.

import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import type { BullpenService } from '../../src/memory/bullpen.js';
import type { EventBus } from '../../src/bus/bus.js';
import { parseSchedulerRunJobId } from '../../src/scheduler/conversation-id.js';
// Shape-only, which is all this needs: it only has to tell a model-grabbed id
// from a short thread name.
import { isUuid } from '../../src/util/uuid.js';

/**
 * Classify a missing-thread miss for agent-facing copy (#1828).
 *
 * Exact match against this run's job UUID gets a precise redirect. We only assert
 * "this IS your job id" on that match — a previous run's job id, a task id, or a
 * recommendation UUID would be a false accusation if worded the same way. On any
 * other UUID-shaped miss while we are demonstrably on a scheduled run, append a
 * softer scheduler-report hint so near-miss hallucinations still get redirected.
 * Generic wording otherwise does not imply the thread once existed.
 *
 * `jobIdAsThreadId` lets call sites emit a greppable warn so recurrence is
 * measurable without logging ordinary thread misses at error.
 *
 * Agent-facing copy lives here (and the catch remapper below). BullpenService
 * throws the same generic "No bullpen thread…" string for non-handler callers;
 * do not reintroduce `Thread X not found` on new paths.
 */
export function classifyBullpenThreadMiss(
  threadId: string,
  conversationId: string | undefined,
): { error: string; jobIdAsThreadId: boolean } {
  const jobId = parseSchedulerRunJobId(conversationId);
  if (jobId && threadId === jobId) {
    return {
      jobIdAsThreadId: true,
      error:
        `${threadId} is your scheduled-job ID, not a bullpen thread ID. ` +
        'Scheduled runs have no thread. To record this run\'s outcome call scheduler-report; ' +
        'to start a discussion call bullpen-post.',
    };
  }
  const generic = `No bullpen thread with ID ${threadId} exists`;
  if (jobId && isUuid(threadId)) {
    return {
      jobIdAsThreadId: false,
      error:
        `${generic}. ` +
        'If you meant to record this scheduled run\'s outcome, call scheduler-report ' +
        "(job_id is derived automatically); do not use the bullpen to report.",
    };
  }
  return { jobIdAsThreadId: false, error: generic };
}

/** True when a service-layer miss should be remapped through classifyBullpenThreadMiss. */
function isBullpenThreadNotFoundMessage(message: string, threadId: string): boolean {
  return (
    message === `Thread ${threadId} not found` ||
    message === `No bullpen thread with ID ${threadId} exists` ||
    message.startsWith(`No bullpen thread with ID ${threadId} exists.`)
  );
}

/**
 * Build the agent-facing miss result and warn when the model passed its own
 * job UUID as thread_id — the recurrence signal for #1828.
 */
export function threadMissResult(ctx: ToolContext, threadId: string, tool: string): ToolResult {
  const miss = classifyBullpenThreadMiss(threadId, ctx.conversationId);
  if (miss.jobIdAsThreadId) {
    ctx.log.warn(
      {
        agentId: ctx.agentId,
        threadId,
        conversationId: ctx.conversationId,
        tool,
      },
      'bullpen: agent passed its scheduled-job UUID as thread_id — redirected to scheduler-report',
    );
  }
  return { success: false, error: miss.error };
}

/** The context every bullpen tool needs, narrowed. */
export interface BullpenToolContext {
  service: BullpenService;
  bus: EventBus;
  agentId: string;
  taskEventId: string;
}

/** Infrastructure the bundle's tools require. Returns the refusal when any is absent. */
export function requireBullpenContext(ctx: ToolContext): BullpenToolContext | ToolResult {
  if (!ctx.bullpenService) {
    return { success: false, error: 'BullpenService not available in context' };
  }
  if (!ctx.bus) {
    return { success: false, error: 'Bus not available in context (requires "bus" capability)' };
  }
  if (!ctx.agentId) {
    return { success: false, error: 'agentId not available in context' };
  }
  if (!ctx.taskEventId) {
    return { success: false, error: 'taskEventId not available in context' };
  }
  return { service: ctx.bullpenService, bus: ctx.bus, agentId: ctx.agentId, taskEventId: ctx.taskEventId };
}

/** Distinguishes a refusal from requireBullpenContext from the narrowed context. */
export function isToolResult(value: BullpenToolContext | ToolResult): value is ToolResult {
  return 'success' in value;
}

/**
 * Read a required string field. Returns the value, or the refusal the model sees.
 * The wording is the one scenario stubs mirror (#2098), so keep it stable.
 */
export function requiredString(ctx: ToolContext, field: string): string | ToolResult {
  const value = ctx.input[field];
  if (typeof value !== 'string' || !value) {
    return { success: false, error: `Missing required field: '${field}'` };
  }
  return value;
}

/**
 * Run a tool body, remapping a service-layer thread miss to the agent-facing copy
 * and logging anything else. Skills return errors, never throw.
 */
export async function runBullpenTool(
  ctx: ToolContext,
  tool: string,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const threadId = ctx.input['thread_id'];
    if (typeof threadId === 'string' && isBullpenThreadNotFoundMessage(message, threadId)) {
      return threadMissResult(ctx, threadId, tool);
    }
    ctx.log.error({ err, tool, agentId: ctx.agentId }, 'Bullpen skill error');
    return { success: false, error: message };
  }
}
