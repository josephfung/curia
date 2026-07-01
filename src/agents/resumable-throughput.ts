// resumable-throughput.ts — derived pace metrics for resumable tasks (#1264).
//
// Pure helpers over progress.resumable + progress.resumableCircuit. No persistence.

import type { EventBus } from '../bus/bus.js';
import { createTaskResumableThroughput } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { ResumableProgressBlock } from '../db/resumable-progress.js';
import type { ResumableCircuitState } from './resumable-circuit-breaker.js';

export interface ResumableThroughputMetrics {
  estimateAvailable: boolean;
  unitsPerSlice: number | null;
  unitsPerWallclockMinute: number | null;
  costPerUnit: number | null;
  etaSlices: number | null;
  etaWallclockMinutes: number | null;
}

/** Nudge when projected slice units reach this fraction of the suggested size (#1265). */
export const THROUGHPUT_SLICE_NUDGE_FRACTION = 0.85;

/**
 * Advisory slice target lands within ±this fraction of measured units/slice (#1265).
 * Provisional default — NOT yet calibrated against real telemetry: no planned/resumable goal has
 * run in prod, so #1264's throughput trail has no baseline to set this from. Re-calibrate from the
 * first real prod baseline (and replace the tautological tolerance test) in #1275.
 */
export const SUGGESTED_SLICE_TOLERANCE_FRACTION = 0.2;

export interface EmitResumableThroughputOptions {
  logger: Logger;
  bus: EventBus;
  taskId: string;
  agentId: string;
  parentEventId?: string;
  resumable: Pick<ResumableProgressBlock, 'done' | 'total' | 'lastSliceUnits'>;
  circuit: ResumableCircuitState;
  now?: Date;
}

/** Derive rolling pace metrics from the resumable block and circuit counters. */
export function computeResumableThroughput(
  resumable: Pick<ResumableProgressBlock, 'done' | 'total' | 'lastSliceUnits'>,
  circuit: ResumableCircuitState | null,
  now: Date = new Date(),
): ResumableThroughputMetrics {
  const coldStart = resumable.done <= 0 || circuit === null || circuit.iterationCount <= 0;
  if (coldStart) {
    return {
      estimateAvailable: false,
      unitsPerSlice: null,
      unitsPerWallclockMinute: null,
      costPerUnit: null,
      etaSlices: null,
      etaWallclockMinutes: null,
    };
  }

  const unitsPerSlice = resumable.done / circuit.iterationCount;

  const startedMs = Date.parse(circuit.startedAt);
  const elapsedMinutes = Number.isFinite(startedMs)
    ? Math.max((now.getTime() - startedMs) / 60_000, 0)
    : 0;
  const unitsPerWallclockMinute = elapsedMinutes > 0
    ? resumable.done / elapsedMinutes
    : null;

  const costPerUnit = circuit.totalCostUsd / resumable.done;

  const remaining = Math.max(resumable.total - resumable.done, 0);
  const etaSlices = unitsPerSlice > 0 ? remaining / unitsPerSlice : null;
  const etaWallclockMinutes = unitsPerWallclockMinute !== null && unitsPerWallclockMinute > 0
    ? remaining / unitsPerWallclockMinute
    : null;

  return {
    estimateAvailable: true,
    unitsPerSlice,
    unitsPerWallclockMinute,
    costPerUnit,
    etaSlices,
    etaWallclockMinutes,
  };
}

function formatRate(value: number, decimals = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(decimals);
}

/** Advisory target slice size from measured units/slice; null on cold start. */
export function suggestedSliceSize(metrics: ResumableThroughputMetrics): number | null {
  if (!metrics.estimateAvailable || metrics.unitsPerSlice === null || metrics.unitsPerSlice <= 0) {
    return null;
  }
  return Math.max(1, Math.round(metrics.unitsPerSlice));
}

/** Linear projection of units processed this slice using last-slice pace as proxy. */
export function projectedSliceUnits(
  turnsUsed: number,
  maxTurns: number,
  lastSliceUnits: number,
  suggestedSize: number,
): number {
  if (maxTurns <= 0) return 0;
  const paceUnits = lastSliceUnits > 0 ? lastSliceUnits : suggestedSize;
  return (turnsUsed / maxTurns) * paceUnits;
}

/** Throughput-aware nudge: projected slice units approach measured avg (#1265). */
export function shouldNudgeFromThroughput(options: {
  turnsUsed: number;
  maxTurns: number;
  unitsPerSlice: number;
  lastSliceUnits: number;
}): boolean {
  const { turnsUsed, maxTurns, unitsPerSlice, lastSliceUnits } = options;
  if (maxTurns <= 0 || unitsPerSlice <= 0) return false;

  const suggested = Math.max(1, Math.round(unitsPerSlice));
  const nudgeAtUnits = suggested * THROUGHPUT_SLICE_NUDGE_FRACTION;
  const projected = projectedSliceUnits(turnsUsed, maxTurns, lastSliceUnits, suggested);
  return projected >= nudgeAtUnits;
}

/** Advisory right-sizing line for resume/plan guidance (#1265). */
export function formatSuggestedSliceSizeAdvice(metrics: ResumableThroughputMetrics): string | null {
  const suggested = suggestedSliceSize(metrics);
  if (suggested === null || metrics.unitsPerSlice === null) return null;

  const avg = formatRate(metrics.unitsPerSlice);
  const tolerancePct = Math.round(SUGGESTED_SLICE_TOLERANCE_FRACTION * 100);
  return (
    `Suggested slice: ~${suggested} units (based on your ~${avg} units/slice avg, `
    + `±${tolerancePct}% advisory — you decide). Aim for ~${suggested} this slice and checkpoint before budget.`
  );
}

/** Human-readable throughput line for resume guidance injected into the system prompt. */
export function formatResumableThroughputForResume(metrics: ResumableThroughputMetrics): string {
  if (!metrics.estimateAvailable) {
    return 'Throughput: no estimate yet (first slice).';
  }

  const parts: string[] = [];
  if (metrics.unitsPerSlice !== null) {
    parts.push(`~${formatRate(metrics.unitsPerSlice)} units/slice avg`);
  }
  if (metrics.unitsPerWallclockMinute !== null) {
    parts.push(`~${formatRate(metrics.unitsPerWallclockMinute)} units/min wallclock`);
  }
  if (metrics.costPerUnit !== null) {
    parts.push(`~$${metrics.costPerUnit.toFixed(4)}/unit`);
  }

  const etaParts: string[] = [];
  if (metrics.etaSlices !== null) {
    etaParts.push(`~${Math.ceil(metrics.etaSlices)} slices`);
  }
  if (metrics.etaWallclockMinutes !== null) {
    etaParts.push(`~${formatRate(metrics.etaWallclockMinutes)} min wallclock`);
  }
  if (etaParts.length > 0) {
    parts.push(`ETA ${etaParts.join(' / ')}`);
  }

  const throughputLine = `Throughput: ${parts.join(', ')}.`;
  const sliceAdvice = formatSuggestedSliceSizeAdvice(metrics);
  return sliceAdvice ? `${throughputLine} ${sliceAdvice}` : throughputLine;
}

/** Structured log + audit event for each paused slice (#1264). */
export async function emitResumableThroughputTelemetry(
  opts: EmitResumableThroughputOptions,
): Promise<ResumableThroughputMetrics> {
  const metrics = computeResumableThroughput(opts.resumable, opts.circuit, opts.now);

  opts.logger.info(
    {
      taskId: opts.taskId,
      agentId: opts.agentId,
      done: opts.resumable.done,
      total: opts.resumable.total,
      lastSliceUnits: opts.resumable.lastSliceUnits,
      circuit: opts.circuit,
      throughput: metrics,
    },
    'Resumable task paused — throughput telemetry',
  );

  try {
    await opts.bus.publish(
      'system',
      createTaskResumableThroughput({
        taskId: opts.taskId,
        agentId: opts.agentId,
        done: opts.resumable.done,
        total: opts.resumable.total,
        lastSliceUnits: opts.resumable.lastSliceUnits,
        iterationCount: opts.circuit.iterationCount,
        stallCount: opts.circuit.stallCount,
        totalCostUsd: opts.circuit.totalCostUsd,
        startedAt: opts.circuit.startedAt,
        estimateAvailable: metrics.estimateAvailable,
        unitsPerSlice: metrics.unitsPerSlice,
        unitsPerWallclockMinute: metrics.unitsPerWallclockMinute,
        costPerUnit: metrics.costPerUnit,
        etaSlices: metrics.etaSlices,
        etaWallclockMinutes: metrics.etaWallclockMinutes,
        parentEventId: opts.parentEventId,
      }),
    );
  } catch (err) {
    opts.logger.error(
      { err, taskId: opts.taskId },
      'Failed to publish task.resumable_throughput audit event',
    );
    throw err;
  }

  return metrics;
}
