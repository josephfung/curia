// deliverable-kg-promotion.ts — promote curated plan deliverables to the KG (#1241).
//
// On planned-parent completion, feeds the deliverable text (never per-item worklogs) through
// extract-facts / extract-relationships, then archives the project's workspace documents.
// Best-effort and non-fatal — failures are logged but never block parent completion.

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { ExecutionLayer } from '../skills/execution.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { TaskCompletedEvent } from '../bus/events.js';
import { readPlanBlock } from '../db/plan-progress.js';
import { resolvePromotionText } from './plan-execution.js';
import type { SkillResult } from '../skills/types.js';

export interface KgPromotionConfig {
  enabled: boolean;
  maxFacts: number;
  maxRelationships: number;
}

export const DEFAULT_KG_PROMOTION_CONFIG: KgPromotionConfig = {
  enabled: true,
  maxFacts: 50,
  maxRelationships: 50,
};

export function resolveKgPromotionConfig(
  yaml?: { enabled?: boolean; maxFacts?: number; maxRelationships?: number },
): KgPromotionConfig {
  return {
    enabled: yaml?.enabled !== false,
    maxFacts: yaml?.maxFacts ?? DEFAULT_KG_PROMOTION_CONFIG.maxFacts,
    maxRelationships: yaml?.maxRelationships ?? DEFAULT_KG_PROMOTION_CONFIG.maxRelationships,
  };
}

/** True when KG promotion is disabled globally or on the task's error_budget. */
export function isKgPromotionDisabled(
  task: Pick<TaskRow, 'errorBudget'>,
  config: KgPromotionConfig,
): boolean {
  if (!config.enabled) return true;
  const budget = task.errorBudget ?? {};
  if (budget['kg_promotion'] === false || budget['kgPromotion'] === false) return true;
  return false;
}

export interface PromoteDeliverableOptions {
  task: TaskRow;
  parentEventId: string;
  taskRepo: TaskRepo;
  workingDocsRepo: WorkingDocsRepo;
  executionLayer: ExecutionLayer;
  config: KgPromotionConfig;
  logger: Logger;
}

export interface PromoteDeliverableResult {
  promoted: boolean;
  reason?: 'disabled' | 'no_plan' | 'no_text' | 'skipped';
  factsStored?: number;
  relationshipsStored?: number;
  archivedDocs?: number;
  errors?: string[];
}

function promotionSource(taskId: string, rootTaskId: string): string {
  return `system:deliverable-kg-promotion/task:${taskId}/project:${rootTaskId}`;
}

async function loadPlanChildren(
  taskRepo: TaskRepo,
  task: TaskRow,
): Promise<Map<string, {
  title: string;
  description: string | null;
  progress: Record<string, unknown>;
  errorBudget: Record<string, unknown>;
}>> {
  const plan = readPlanBlock(task.progress);
  if (!plan) return new Map();

  const children = new Map<string, {
    title: string;
    description: string | null;
    progress: Record<string, unknown>;
    errorBudget: Record<string, unknown>;
  }>();

  for (const step of plan.steps) {
    if (!step.taskId) continue;
    const child = await taskRepo.getTask(step.taskId);
    if (!child) continue;
    children.set(step.taskId, {
      title: child.title,
      description: child.description,
      progress: child.progress,
      errorBudget: child.errorBudget,
    });
  }

  return children;
}

/**
 * Promote a completed planned parent's curated deliverable to the KG and archive workspace docs.
 * Never throws — callers may fire-and-forget.
 */
export async function promoteDeliverableToKg(
  opts: PromoteDeliverableOptions,
): Promise<PromoteDeliverableResult> {
  const { task, config, logger } = opts;

  if (isKgPromotionDisabled(task, config)) {
    logger.debug({ taskId: task.id }, 'Deliverable KG promotion: disabled — skipping');
    return { promoted: false, reason: 'disabled' };
  }

  const plan = readPlanBlock(task.progress);
  if (!plan) {
    return { promoted: false, reason: 'no_plan' };
  }

  const children = await loadPlanChildren(opts.taskRepo, task);
  const text = resolvePromotionText(plan, children);
  if (!text) {
    logger.debug({ taskId: task.id }, 'Deliverable KG promotion: no promotion text — skipping extraction');
    return { promoted: false, reason: 'no_text' };
  }

  const rootTaskId = (await opts.taskRepo.resolveProjectRootTaskId(task.id)) ?? task.id;
  const source = promotionSource(task.id, rootTaskId);
  const agentId = task.sourceAgentId ?? task.agentId ?? 'system';
  const conversationId = task.conversationId ?? `task:${task.id}`;
  const invokeOptions = {
    agentId,
    conversationId,
    parentEventId: opts.parentEventId,
    taskEventId: task.id,
  };
  const callerContext = {
    contactId: 'system',
    role: null as string | null,
    channel: 'system',
  };

  const errors: string[] = [];
  let factsStored = 0;
  let relationshipsStored = 0;

  const skillResults = await Promise.allSettled([
    opts.executionLayer.invoke(
      'extract-relationships',
      { text, source, max_stored: config.maxRelationships },
      callerContext,
      invokeOptions,
    ),
    opts.executionLayer.invoke(
      'extract-facts',
      { text, source, max_stored: config.maxFacts },
      callerContext,
      invokeOptions,
    ),
  ]);

  for (const [index, result] of skillResults.entries()) {
    const skillName = index === 0 ? 'extract-relationships' : 'extract-facts';
    if (result.status === 'rejected') {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${skillName}: ${message}`);
      logger.error(
        { err: result.reason as Error, taskId: task.id, skill: skillName },
        'Deliverable KG promotion: skill threw unexpectedly',
      );
      continue;
    }
    const skillResult = result.value as SkillResult;
    if (!skillResult.success) {
      errors.push(`${skillName}: ${skillResult.error ?? 'unknown error'}`);
      logger.warn(
        { taskId: task.id, skill: skillName, error: skillResult.error },
        'Deliverable KG promotion: skill returned failure',
      );
      continue;
    }
    if (skillName === 'extract-relationships' && skillResult.data) {
      const data = skillResult.data as { extracted?: number; confirmed?: number };
      relationshipsStored = (data.extracted ?? 0) + (data.confirmed ?? 0);
    }
    if (skillName === 'extract-facts' && skillResult.data) {
      const data = skillResult.data as { stored?: number; redirected?: number };
      factsStored = (data.stored ?? 0) + (data.redirected ?? 0);
    }
  }

  let archivedDocs = 0;
  try {
    archivedDocs = await opts.workingDocsRepo.archiveProjectWorkspaceDocs(rootTaskId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`archive: ${message}`);
    logger.error({ err, taskId: task.id, rootTaskId }, 'Deliverable KG promotion: workspace archival failed');
  }

  logger.info(
    {
      taskId: task.id,
      rootTaskId,
      deliverableStepId: plan.deliverableStepId,
      factsStored,
      relationshipsStored,
      archivedDocs,
      errorCount: errors.length,
    },
    'Deliverable KG promotion complete',
  );

  return {
    promoted: true,
    factsStored,
    relationshipsStored,
    archivedDocs,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export interface DeliverableKgPromotionSubscriberOptions {
  bus: EventBus;
  taskRepo: TaskRepo;
  workingDocsRepo: WorkingDocsRepo;
  executionLayer: ExecutionLayer;
  config: KgPromotionConfig;
  logger: Logger;
}

/**
 * System-layer subscriber: on planned-parent task.completed, promote the deliverable to the KG.
 */
export class DeliverableKgPromotionSubscriber {
  constructor(private readonly opts: DeliverableKgPromotionSubscriberOptions) {}

  start(): void {
    this.opts.bus.subscribe('task.completed', 'system', async (event) => {
      const completed = event as TaskCompletedEvent;
      const { taskId } = completed.payload;

      try {
        const task = await this.opts.taskRepo.getTask(taskId);
        if (!task || !readPlanBlock(task.progress)) return;

        await promoteDeliverableToKg({
          task,
          parentEventId: completed.id,
          taskRepo: this.opts.taskRepo,
          workingDocsRepo: this.opts.workingDocsRepo,
          executionLayer: this.opts.executionLayer,
          config: this.opts.config,
          logger: this.opts.logger,
        });
      } catch (err) {
        this.opts.logger.error(
          { err, taskId },
          'Deliverable KG promotion: unexpected error in subscriber — parent completion unaffected',
        );
      }
    });

    this.opts.logger.info(
      { kgPromotion: this.opts.config },
      'DeliverableKgPromotionSubscriber started',
    );
  }
}
