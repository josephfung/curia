// plan-execution.ts — pure reconcile helpers for the plan skill (#1237).

import { preparePlanBlock } from '../db/plan-progress.js';
import type { PlanProgressBlock, PlanStepDescriptor } from '../db/plan-progress.js';

export interface PlanStepInput {
  id: string;
  title: string;
  description?: string;
  target_agent_id: string;
  blocked_by_step_id?: string | null;
  waiting_on_contact_id?: string | null;
  waiting_on_text?: string | null;
  /** When false, the step stays in the plan block without a child row (lazy expansion). */
  materialize?: boolean;
  /** When true on a materialized step, creates a single iterate leaf (not one row per item). */
  resumable?: boolean;
}

export interface PlanChildRowSnapshot {
  title: string;
  description: string | null;
  agentId: string;
  waitingOnContactId: string | null;
  waitingOnText: string | null;
  errorBudget: Record<string, unknown>;
}

const PLACEHOLDER_TASK_ID_PREFIX = '00000000-0000-4000-8000-';

export function parsePlanStepInput(raw: unknown): PlanStepInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id.trim()) return null;
  if (typeof obj.title !== 'string' || !obj.title.trim()) return null;
  if (typeof obj.target_agent_id !== 'string' || !obj.target_agent_id.trim()) return null;

  const step: PlanStepInput = {
    id: obj.id.trim(),
    title: obj.title.trim(),
    target_agent_id: obj.target_agent_id.trim(),
  };

  if (typeof obj.description === 'string') step.description = obj.description;
  if (obj.blocked_by_step_id === null) {
    step.blocked_by_step_id = null;
  } else if (typeof obj.blocked_by_step_id === 'string' && obj.blocked_by_step_id.trim()) {
    step.blocked_by_step_id = obj.blocked_by_step_id.trim();
  }
  if (typeof obj.waiting_on_contact_id === 'string' && obj.waiting_on_contact_id.trim()) {
    step.waiting_on_contact_id = obj.waiting_on_contact_id.trim();
  }
  if (typeof obj.waiting_on_text === 'string' && obj.waiting_on_text.trim()) {
    step.waiting_on_text = obj.waiting_on_text.trim();
  }
  if (obj.materialize === false) step.materialize = false;
  if (obj.resumable === true) step.resumable = true;

  return step;
}

/** Validate dependency graph: known blockers, no cycles, no lazy predecessors. */
export function validatePlanStepsGraph(steps: readonly PlanStepInput[]): string | null {
  const stepById = new Map(steps.map((s) => [s.id, s]));

  for (const step of steps) {
    if (!step.blocked_by_step_id) continue;
    const blocker = stepById.get(step.blocked_by_step_id);
    if (!blocker) {
      return `blocked_by_step_id '${step.blocked_by_step_id}' is not a step in this plan`;
    }
    if (blocker.materialize === false) {
      return `blocked_by_step_id '${step.blocked_by_step_id}' refers to a lazy step — materialize the predecessor or remove the dependency`;
    }
  }

  for (const step of steps) {
    const visiting = new Set<string>();
    let current: string | null | undefined = step.id;
    while (current) {
      if (visiting.has(current)) {
        return `plan dependency cycle detected involving step '${step.id}'`;
      }
      visiting.add(current);
      current = stepById.get(current)?.blocked_by_step_id ?? null;
    }
  }

  return null;
}

export function parsePlanStepsInput(raw: unknown): PlanStepInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: PlanStepInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const step = parsePlanStepInput(item);
    if (!step || seen.has(step.id)) return null;
    seen.add(step.id);
    steps.push(step);
  }
  if (validatePlanStepsGraph(steps) !== null) return null;
  return steps;
}

/** Resolve blocked_by_step_id to a child task UUID using the step-id → task-id map. */
export function resolveBlockedByTaskId(
  blockedByStepId: string | null | undefined,
  stepTaskIds: Readonly<Record<string, string | null>>,
): string | null {
  if (!blockedByStepId) return null;
  const taskId = stepTaskIds[blockedByStepId];
  return taskId ?? null;
}

/** Child task ids present in the old plan but absent from the new step list. */
export function findRemovedChildTaskIds(
  existingPlan: PlanProgressBlock | null,
  newStepIds: ReadonlySet<string>,
): string[] {
  if (!existingPlan) return [];
  const removed: string[] = [];
  for (const step of existingPlan.steps) {
    if (!newStepIds.has(step.id) && step.taskId) {
      removed.push(step.taskId);
    }
  }
  return removed;
}

/** Reuse an existing child task id when the step id matches the prior plan block. */
export function existingTaskIdForStep(
  existingPlan: PlanProgressBlock | null,
  stepId: string,
): string | null {
  const prior = existingPlan?.steps.find((s) => s.id === stepId);
  return prior?.taskId ?? null;
}

export function buildPlanStepDescriptors(
  steps: readonly PlanStepInput[],
  stepTaskIds: Readonly<Record<string, string | null>>,
): PlanStepDescriptor[] {
  return steps.map((step) => ({
    id: step.id,
    taskId: step.materialize === false ? null : (stepTaskIds[step.id] ?? null),
  }));
}

export function validateDeliverableStepId(
  deliverableStepId: string | null | undefined,
  steps: readonly PlanStepInput[],
): string | null | undefined {
  if (deliverableStepId === undefined) return undefined;
  if (deliverableStepId === null) return null;
  const trimmed = deliverableStepId.trim();
  if (!trimmed) return undefined;
  return steps.some((s) => s.id === trimmed) ? trimmed : undefined;
}

/** True when a reused child row no longer matches the requested step fields. */
export function planStepDriftsFromChild(step: PlanStepInput, child: PlanChildRowSnapshot): boolean {
  if (child.title !== step.title) return true;
  if ((child.description ?? undefined) !== step.description) return true;
  if (child.agentId !== step.target_agent_id) return true;
  if ((child.waitingOnContactId ?? undefined) !== (step.waiting_on_contact_id ?? undefined)) return true;
  if ((child.waitingOnText ?? undefined) !== (step.waiting_on_text ?? undefined)) return true;
  const childResumable = child.errorBudget?.['resumable'] === true;
  return childResumable !== (step.resumable === true);
}

/** Project descriptors for preflight validation before any child rows are written. */
export function projectPlanStepTaskIds(
  steps: readonly PlanStepInput[],
  existingPlan: PlanProgressBlock | null,
): Record<string, string | null> {
  const stepTaskIds: Record<string, string | null> = {};
  steps.forEach((step, index) => {
    if (step.materialize === false) {
      stepTaskIds[step.id] = null;
      return;
    }
    stepTaskIds[step.id] = existingTaskIdForStep(existingPlan, step.id)
      ?? `${PLACEHOLDER_TASK_ID_PREFIX}${String(index).padStart(12, '0')}`;
  });
  return stepTaskIds;
}

/** Preflight the plan block size/shape before mutating child rows. */
export function preflightPlanBlockWrite(
  steps: readonly PlanStepInput[],
  existingPlan: PlanProgressBlock | null,
  deliverableStepId: string | null,
  next: string,
) {
  const descriptors = buildPlanStepDescriptors(steps, projectPlanStepTaskIds(steps, existingPlan));
  return preparePlanBlock({
    steps: descriptors,
    deliverableStepId,
    done: 0,
    total: descriptors.length,
    next,
  });
}

/** Count materialized iterate-leaf steps (resumable) vs heterogeneous rows. */
export function countMaterializationKinds(steps: readonly PlanStepInput[]): {
  iterateLeaves: number;
  heterogeneousRows: number;
  lazySteps: number;
} {
  let iterateLeaves = 0;
  let heterogeneousRows = 0;
  let lazySteps = 0;
  for (const step of steps) {
    if (step.materialize === false) {
      lazySteps++;
    } else if (step.resumable === true) {
      iterateLeaves++;
    } else {
      heterogeneousRows++;
    }
  }
  return { iterateLeaves, heterogeneousRows, lazySteps };
}

/** Extract the best available output text from a completed child task. */
export function extractTaskOutputNote(task: {
  title: string;
  description: string | null;
  progress: Record<string, unknown>;
}): string {
  const notes = task.progress.notes;
  if (Array.isArray(notes) && notes.length > 0) {
    const last = notes[notes.length - 1] as { note?: string } | null;
    if (last?.note && last.note.trim().length > 0) return last.note.trim();
  }
  if (task.description && task.description.trim().length > 0) return task.description.trim();
  return task.title;
}

/** Build the parent completion note from the deliverable step or a child-summary rollup. */
export function resolvePlanCompletionNote(
  plan: PlanProgressBlock,
  children: ReadonlyMap<string, { title: string; description: string | null; progress: Record<string, unknown> }>,
): string {
  if (plan.deliverableStepId) {
    const step = plan.steps.find((s) => s.id === plan.deliverableStepId);
    const child = step?.taskId ? children.get(step.taskId) : undefined;
    if (child) return extractTaskOutputNote(child);
  }

  const lines: string[] = [];
  for (const step of plan.steps) {
    if (!step.taskId) continue;
    const child = children.get(step.taskId);
    if (!child) continue;
    lines.push(`${child.title}: ${extractTaskOutputNote(child)}`);
  }
  return lines.join('\n\n');
}

/** True when every planned child is resolved and the deliverable step (if any) is done. */
export function isPlanReadyForAutoComplete(
  plan: PlanProgressBlock,
  childStatusByTaskId: Readonly<Record<string, string>>,
): boolean {
  if (plan.done !== plan.total || plan.total === 0) return false;

  if (plan.deliverableStepId) {
    const step = plan.steps.find((s) => s.id === plan.deliverableStepId);
    if (!step?.taskId) return false;
    return childStatusByTaskId[step.taskId] === 'done';
  }

  return true;
}
