// resumable-task.ts — platform harness for resumable iterate leaves (#1173).
//
// API shape decision: checkpoint is a dedicated skill (not folded into task-update).
// task-update appends human-readable progress notes; checkpoint writes the typed
// progress.resumable block that the runtime safety-net (#1174) reads on resume.

import {
  readResumableBlock,
  type ResumableProgressBlock,
} from '../db/resumable-progress.js';
import type { Logger } from '../logger.js';
import {
  indexPathForDirectory,
  resolveWorkspacePrefixFromTaskContent,
} from './document-workspace.js';

export const CHECKPOINT_SKILL_NAME = 'checkpoint';

/** Remaining-turn fraction that triggers the one-time budget nudge (~15%). */
export const CHECKPOINT_BUDGET_NUDGE_FRACTION = 0.15;

/** Bound task context threaded from scheduler fires into agent.task metadata. */
export interface BoundTaskContext {
  taskId: string;
  errorBudget?: Record<string, unknown>;
  tags?: string[];
  progress?: Record<string, unknown>;
  /** Populated from the project workspace directory when document-workspace is active (#1209). */
  workspaceManifestPath?: string;
}

/**
 * Phase-1 prompt-cache / mid-system confirmation (#1173 acceptance):
 * - Anthropic (direct + via OpenRouter): prefix caching on system+tools via cache_control;
 *   volatile per-turn content must stay out of that prefix.
 * - OpenAI / DeepSeek / Grok (OpenRouter): automatic prefix caching — same tail rule.
 * - Our AnthropicProvider concatenates every role:system message into the top-level
 *   `system` param, so mid-array system messages still land in the cached prefix today.
 * - Budget nudge therefore uses role:user at the message tail (invalidates only the
 *   messages-cache tier). Opus 4.8 mid-conversation-system beta is not wired yet; when
 *   it is, the nudge can migrate to a non-spoofable operator channel without changing
 *   correctness (the #1174 safety-net is the guarantee, not the nudge).
 */

export function isResumableTask(ctx: Pick<BoundTaskContext, 'errorBudget' | 'tags' | 'progress'>): boolean {
  if (ctx.errorBudget?.['resumable'] === true) return true;
  if (ctx.tags?.includes('resumable')) return true;
  if (readResumableBlock(ctx.progress ?? {})) return true;
  return false;
}

/** Minimum remaining turns before the one-time checkpoint nudge fires. */
export function checkpointNudgeThreshold(maxTurns: number): number {
  return Math.max(1, Math.floor(maxTurns * CHECKPOINT_BUDGET_NUDGE_FRACTION));
}

export function shouldSendCheckpointBudgetNudge(
  turnsUsed: number,
  maxTurns: number,
  alreadySent: boolean,
): boolean {
  if (alreadySent || maxTurns <= 0) return false;
  const remaining = maxTurns - turnsUsed;
  return remaining > 0 && remaining <= checkpointNudgeThreshold(maxTurns);
}

export function buildResumableTaskGuidanceBlock(options?: {
  workspaceManifestPath?: string;
  /** True when #1209 appended a ## Workspace Manifest block to the task message tail. */
  workspaceManifestInjected?: boolean;
}): string {
  const lines = [
    '## Resumable Task',
    '',
    'This is a long task. Checkpoint your progress periodically and before you run low on',
    'budget. On resume, your last checkpoint will be handed back to you — continue from it.',
    '',
    'Call the `checkpoint` skill with your cursor/position, done/total counts, accumulator',
    '(or a document pointer after spill), last_slice_units, and a one-line `next` describing',
    'what to do on the next slice.',
  ];

  if (options?.workspaceManifestInjected) {
    lines.push(
      '',
      'This project has a document workspace. On resume, a **## Workspace Manifest** block is',
      'appended to your task message (index projection only). Re-read it before continuing;',
      'use `doc-read` for document bodies and specific sections.',
    );
    if (options.workspaceManifestPath) {
      lines.push(`Index path: \`${options.workspaceManifestPath}\`.`);
    }
  } else if (options?.workspaceManifestPath) {
    lines.push(
      '',
      `This project has a document workspace. Re-read the manifest at \`${options.workspaceManifestPath}\` on resume before continuing.`,
    );
  }

  return lines.join('\n');
}

export function buildResumableCheckpointResumeBlock(block: ResumableProgressBlock): string {
  const accumulatorSummary = typeof block.accumulator === 'object'
    && block.accumulator !== null
    && !Array.isArray(block.accumulator)
    && (block.accumulator as Record<string, unknown>).kind === 'document'
    ? `document pointer ${JSON.stringify(block.accumulator)}`
    : JSON.stringify(block.accumulator);

  return [
    '## Last Checkpoint (resume from here)',
    '',
    `- Progress: ${block.done} / ${block.total} (${block.lastSliceUnits} units last slice)`,
    `- Cursor: ${JSON.stringify(block.cursor)}`,
    `- Accumulator: ${accumulatorSummary}`,
    `- Next: ${block.next}`,
    block.checkpointedAt ? `- Checkpointed at: ${block.checkpointedAt}` : '',
  ].filter(Boolean).join('\n');
}

export function buildCheckpointBudgetNudgeMessage(remainingTurns: number, maxTurns: number): string {
  return [
    '[Platform — resumable task budget nudge]',
    `You have ${remainingTurns} of ${maxTurns} turns remaining on this resumable task.`,
    'Call `checkpoint` with your current progress now, then pause — do not keep iterating.',
    'A partial checkpoint is success; the platform will resume you on the next slice.',
  ].join(' ');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseBoundTaskRecord(raw: unknown): BoundTaskContext | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.taskId !== 'string' || !raw.taskId) return null;
  const ctx: BoundTaskContext = { taskId: raw.taskId };
  if (isPlainObject(raw.errorBudget)) ctx.errorBudget = raw.errorBudget;
  if (Array.isArray(raw.tags)) ctx.tags = raw.tags.filter((t): t is string => typeof t === 'string');
  if (isPlainObject(raw.progress)) ctx.progress = raw.progress;
  if (typeof raw.workspaceManifestPath === 'string' && raw.workspaceManifestPath.length > 0) {
    ctx.workspaceManifestPath = raw.workspaceManifestPath;
  }
  return ctx;
}

/** Read bound-task context from agent.task metadata (scheduler path). */
export function boundTaskFromMetadata(metadata: Record<string, unknown> | undefined): BoundTaskContext | null {
  if (!metadata) return null;
  return parseBoundTaskRecord(metadata['boundTask']);
}

/** Fallback: parse task_id + progress from scheduler JSON content when metadata is absent. */
export function boundTaskFromSchedulerContent(content: string): BoundTaskContext | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.task_id !== 'string' || !parsed.task_id) return null;
    const ctx: BoundTaskContext = { taskId: parsed.task_id };
    if (isPlainObject(parsed.progress)) ctx.progress = parsed.progress;
    return ctx;
  } catch {
    return null;
  }
}

export function resolveBoundTaskContext(
  metadata: Record<string, unknown> | undefined,
  rawTaskContent: string,
  channelId: string,
): BoundTaskContext | null {
  const fromMeta = boundTaskFromMetadata(metadata);
  const ctx = fromMeta ?? (channelId === 'scheduler' ? boundTaskFromSchedulerContent(rawTaskContent) : null);
  if (!ctx) return null;
  enrichBoundTaskWorkspace(ctx, rawTaskContent);
  return ctx;
}

/** Derive the workspace index path from task content / resumable accumulator (#1209 compose). */
export function enrichBoundTaskWorkspace(ctx: BoundTaskContext, rawTaskContent: string): void {
  if (ctx.workspaceManifestPath) return;
  const prefix = resolveWorkspacePrefixFromTaskContent(rawTaskContent);
  if (prefix) ctx.workspaceManifestPath = indexPathForDirectory(prefix);
}

// ---------------------------------------------------------------------------
// Executor outcome contract (#1174) — done | paused | failed{reason, retryable}
// ---------------------------------------------------------------------------

/** Protocol marker on agent.response when a resumable executor pauses mid-work. */
export const EXECUTION_PAUSED_PROTOCOL = 'execution_paused';

/** Coarse failure reasons for executor invocations (planner-facing). */
export type ExecutorFailureReason =
  | 'budget_max_turns'
  | 'tool_error'
  | 'api_error'
  | 'blocked';

export type ExecutorOutcome =
  | { status: 'done' }
  | { status: 'paused'; taskId?: string; progress: ResumableProgressBlock }
  | { status: 'failed'; reason: ExecutorFailureReason; retryable: boolean };

export interface ExecutionPausedPayload {
  _curia_protocol: typeof EXECUTION_PAUSED_PROTOCOL;
  task_id?: string;
  done: number;
  total: number;
  cursor: ResumableProgressBlock['cursor'];
  last_slice_units: number;
  next: string;
  /** Aggregate LLM cost for this slice (USD) — feeds resumable cost ceiling (#1176). */
  slice_cost_usd?: number;
}

export interface DelegatePausedResult {
  paused: true;
  agent: string;
  task_id?: string;
  done: number;
  total: number;
  next: string;
  message: string;
}

/** Human-readable progress summary for coordinator / delegate consumers. */
export function formatPausedProgressMessage(
  progress: Pick<ResumableProgressBlock, 'done' | 'total' | 'next'>,
): string {
  return `Still working — ${progress.done} of ${progress.total} complete. ${progress.next}`;
}

/** Build the deterministic JSON body for a paused executor response. */
export function buildExecutionPausedResponse(options: {
  taskId?: string;
  progress: ResumableProgressBlock;
  sliceCostUsd?: number;
}): string {
  const payload: ExecutionPausedPayload = {
    _curia_protocol: EXECUTION_PAUSED_PROTOCOL,
    done: options.progress.done,
    total: options.progress.total,
    cursor: options.progress.cursor,
    last_slice_units: options.progress.lastSliceUnits,
    next: options.progress.next,
  };
  if (options.taskId) payload.task_id = options.taskId;
  if (options.sliceCostUsd !== undefined && options.sliceCostUsd > 0) {
    payload.slice_cost_usd = options.sliceCostUsd;
  }
  return JSON.stringify(payload);
}

/** Parse a paused protocol payload from agent.response content. */
export function parseExecutionPausedPayload(content: string, logger?: Logger): ExecutionPausedPayload | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed['_curia_protocol'] !== EXECUTION_PAUSED_PROTOCOL) return null;
    if (typeof parsed['done'] !== 'number' || typeof parsed['total'] !== 'number') return null;
    if (typeof parsed['next'] !== 'string') return null;
    if (typeof parsed['last_slice_units'] !== 'number') return null;
    const cursor = parsed['cursor'];
    if (cursor !== null && typeof cursor !== 'string' && !isPlainObject(cursor)) return null;
    const payload: ExecutionPausedPayload = {
      _curia_protocol: EXECUTION_PAUSED_PROTOCOL,
      done: parsed['done'],
      total: parsed['total'],
      cursor: cursor as ResumableProgressBlock['cursor'],
      last_slice_units: parsed['last_slice_units'],
      next: parsed['next'],
    };
    if (typeof parsed['task_id'] === 'string' && parsed['task_id'].length > 0) {
      payload.task_id = parsed['task_id'];
    }
    return payload;
  } catch (err) {
    logger?.warn(
      { err, contentPreview: content.slice(0, 200) },
      'Failed to parse execution_paused protocol payload — treating as non-paused response',
    );
    return null;
  }
}

/** Parse a delegate skill success payload that carries paused (not failed) fields. */
export function parseDelegatePausedData(data: unknown, logger?: Logger): DelegatePausedResult | null {
  if (data === null || data === undefined) return null;
  let record: Record<string, unknown>;
  if (typeof data === 'string') {
    try {
      record = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      logger?.warn(
        { err, dataPreview: data.slice(0, 200) },
        'Failed to parse delegate paused payload JSON — treating as non-paused result',
      );
      return null;
    }
  } else if (typeof data === 'object' && !Array.isArray(data)) {
    record = data as Record<string, unknown>;
  } else {
    return null;
  }
  if (record['paused'] !== true) return null;
  if (typeof record['agent'] !== 'string') return null;
  if (typeof record['done'] !== 'number' || typeof record['total'] !== 'number') return null;
  if (typeof record['next'] !== 'string' || typeof record['message'] !== 'string') return null;
  return {
    paused: true,
    agent: record['agent'],
    done: record['done'],
    total: record['total'],
    next: record['next'],
    message: record['message'],
    ...(typeof record['task_id'] === 'string' && { task_id: record['task_id'] }),
  };
}
