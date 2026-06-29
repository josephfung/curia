// plan-progress.ts — typed read/write helpers for tasks.progress.plan.
//
// Shared representation for the plan primitive (#1236). Persisted under the existing
// tasks.progress JSONB — no schema migration.

import { serializedUtf8Bytes } from './resumable-progress.js';

/** Max serialized size (UTF-8 bytes) of the entire plan block. */
export const PLAN_BLOCK_MAX_BYTES = 8192;

/** Lightweight pointer to a materialized child task row — no per-item payloads inline. */
export interface PlanStepDescriptor {
  /** Stable step id within this plan (referenced by deliverableStepId). */
  id: string;
  /** Child task row id once materialized; null until the step is created. */
  taskId: string | null;
}

export interface PlanProgressBlock {
  /** Ordered planned child-step descriptors (pointers only). */
  steps: PlanStepDescriptor[];
  /** Which step's output is the parent's result; null = default child-summary rollup. */
  deliverableStepId: string | null;
  done: number;
  total: number;
  next: string;
  /** ISO timestamp of the last plan write. */
  plannedAt?: string;
}

export interface TaskProgressWithPlan {
  notes?: Array<{ at: string; note: string }>;
  plan?: PlanProgressBlock;
  [key: string]: unknown;
}

export type PlanWriteResult =
  | { ok: true; block: PlanProgressBlock; progress: TaskProgressWithPlan }
  | { ok: false; code: 'block_overflow'; bytes: number; maxBytes: number }
  | { ok: false; code: 'invalid_block'; message: string };

/** Child statuses that count as resolved for the "X of Y" rollup. */
const RESOLVED_CHILD_STATUSES = new Set(['done', 'cancelled']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function planBlockBytes(block: PlanProgressBlock): number {
  return serializedUtf8Bytes(block);
}

export function isPlanBlockWithinCap(block: PlanProgressBlock): boolean {
  return planBlockBytes(block) <= PLAN_BLOCK_MAX_BYTES;
}

/** A task is a planned step iff progress.plan is present and valid. */
export function isPlannedStep(progress: Record<string, unknown>): boolean {
  return readPlanBlock(progress) !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
    return undefined;
  }
  return raw;
}

function parseNext(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseStepId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTaskId(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return UUID_RE.test(trimmed) ? trimmed : undefined;
}

function readTaskIdField(raw: Record<string, unknown>): unknown {
  if ('taskId' in raw) return raw.taskId;
  if ('task_id' in raw) return raw.task_id;
  return undefined;
}

function parseStepDescriptor(raw: unknown): PlanStepDescriptor | undefined {
  if (!isPlainObject(raw)) return undefined;

  const id = parseStepId(raw.id);
  const taskId = parseTaskId(readTaskIdField(raw));
  if (id === undefined || taskId === undefined) return undefined;

  return { id, taskId };
}

function parseSteps(raw: unknown): PlanStepDescriptor[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const steps: PlanStepDescriptor[] = [];
  const seenIds = new Set<string>();

  for (const item of raw) {
    const step = parseStepDescriptor(item);
    if (!step || seenIds.has(step.id)) return undefined;
    seenIds.add(step.id);
    steps.push(step);
  }

  return steps;
}

function parseDeliverableStepId(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  return parseStepId(raw);
}

function readDeliverableStepIdField(raw: Record<string, unknown>): unknown {
  if ('deliverableStepId' in raw) return raw.deliverableStepId;
  if ('deliverable_step_id' in raw) return raw.deliverable_step_id;
  return undefined;
}

/** Parse a plan block from persisted progress JSON. Returns null when absent or invalid. */
export function parsePlanBlock(raw: unknown): PlanProgressBlock | null {
  if (!isPlainObject(raw)) return null;

  const steps = parseSteps(raw.steps);
  const deliverableStepId = parseDeliverableStepId(readDeliverableStepIdField(raw));
  const done = parseNonNegativeInt(raw.done);
  const total = parseNonNegativeInt(raw.total);
  const next = parseNext(raw.next);

  if (
    steps === undefined
    || deliverableStepId === undefined
    || done === undefined
    || total === undefined
    || next === undefined
  ) {
    return null;
  }

  if (done > total || total !== steps.length) return null;

  if (deliverableStepId !== null && !steps.some((s) => s.id === deliverableStepId)) {
    return null;
  }

  const block: PlanProgressBlock = {
    steps,
    deliverableStepId,
    done,
    total,
    next,
  };

  if (typeof raw.plannedAt === 'string') {
    block.plannedAt = raw.plannedAt;
  } else if (typeof raw.planned_at === 'string') {
    block.plannedAt = raw.planned_at;
  }

  return block;
}

/** Read the plan block from a task progress object. */
export function readPlanBlock(progress: Record<string, unknown>): PlanProgressBlock | null {
  return parsePlanBlock(progress.plan);
}

function validateBlockForWrite(block: PlanProgressBlock): PlanWriteResult | null {
  const bytes = planBlockBytes(block);
  if (bytes > PLAN_BLOCK_MAX_BYTES) {
    return {
      ok: false,
      code: 'block_overflow',
      bytes,
      maxBytes: PLAN_BLOCK_MAX_BYTES,
    };
  }
  return null;
}

export interface PreparePlanBlockInput {
  steps: PlanStepDescriptor[];
  deliverableStepId: string | null;
  done: number;
  total: number;
  next: string;
  plannedAt?: string;
}

/** Validate and normalize a plan block before persistence. */
export function preparePlanBlock(input: PreparePlanBlockInput): PlanWriteResult {
  const parsed = parsePlanBlock({
    steps: input.steps,
    deliverableStepId: input.deliverableStepId,
    done: input.done,
    total: input.total,
    next: input.next,
    plannedAt: input.plannedAt,
  });

  if (!parsed) {
    return { ok: false, code: 'invalid_block', message: 'plan block failed validation' };
  }

  const block: PlanProgressBlock = {
    ...parsed,
    plannedAt: input.plannedAt ?? new Date().toISOString(),
  };

  const capError = validateBlockForWrite(block);
  if (capError) return capError;

  return { ok: true, block, progress: {} };
}

/** Merge a validated plan block into an existing progress object (preserves sibling blocks). */
export function mergePlanIntoProgress(
  progress: Record<string, unknown>,
  block: PlanProgressBlock,
): TaskProgressWithPlan {
  return { ...progress, plan: block };
}

/** Validate, merge, and return the updated progress object. */
export function writePlanBlock(
  progress: Record<string, unknown>,
  input: PreparePlanBlockInput,
): PlanWriteResult {
  const prepared = preparePlanBlock(input);
  if (!prepared.ok) return prepared;

  const merged = mergePlanIntoProgress(progress, prepared.block);
  const mergedBytes = serializedUtf8Bytes(merged.plan);
  if (mergedBytes > PLAN_BLOCK_MAX_BYTES) {
    return {
      ok: false,
      code: 'block_overflow',
      bytes: mergedBytes,
      maxBytes: PLAN_BLOCK_MAX_BYTES,
    };
  }

  return { ok: true, block: prepared.block, progress: merged };
}

/**
 * Pure "X of Y" rollup for a planned parent: resolved children / total planned steps.
 * done and cancelled child statuses count as resolved.
 */
export function computePlanRollup(
  steps: readonly PlanStepDescriptor[],
  childStatusByTaskId: Readonly<Record<string, string>>,
): { done: number; total: number } {
  const total = steps.length;
  let done = 0;

  for (const step of steps) {
    if (!step.taskId) continue;
    const status = childStatusByTaskId[step.taskId];
    if (status !== undefined && RESOLVED_CHILD_STATUSES.has(status)) {
      done++;
    }
  }

  return { done, total };
}
