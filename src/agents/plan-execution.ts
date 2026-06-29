// plan-execution.ts — pure reconcile helpers for the plan skill (#1237).

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
