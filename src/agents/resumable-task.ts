// resumable-task.ts — platform harness for resumable iterate leaves (#1173).
//
// API shape decision: checkpoint is a dedicated skill (not folded into task-update).
// task-update appends human-readable progress notes; checkpoint writes the typed
// progress.resumable block that the runtime safety-net (#1174) reads on resume.

import {
  readResumableBlock,
  type ResumableProgressBlock,
} from '../db/resumable-progress.js';

export const CHECKPOINT_SKILL_NAME = 'checkpoint';

/** Remaining-turn fraction that triggers the one-time budget nudge (~15%). */
export const CHECKPOINT_BUDGET_NUDGE_FRACTION = 0.15;

/** Bound task context threaded from scheduler fires into agent.task metadata. */
export interface BoundTaskContext {
  taskId: string;
  errorBudget?: Record<string, unknown>;
  tags?: string[];
  progress?: Record<string, unknown>;
  /** Populated when #1209 document-workspace guidance lands. */
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

  if (options?.workspaceManifestPath) {
    lines.push(
      '',
      `This project has a document workspace. Re-read the manifest at \`${options.workspaceManifestPath}\` on resume before continuing.`,
    );
  } else {
    lines.push(
      '',
      '_When a document workspace is configured for this project (#1209), the manifest path will appear here._',
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
  content: string,
  channelId: string,
): BoundTaskContext | null {
  const fromMeta = boundTaskFromMetadata(metadata);
  if (fromMeta) return fromMeta;
  if (channelId === 'scheduler') return boundTaskFromSchedulerContent(content);
  return null;
}
