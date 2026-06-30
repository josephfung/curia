import { describe, it, expect, vi } from 'vitest';
import {
  computeResumableThroughput,
  emitResumableThroughputTelemetry,
  formatResumableThroughputForResume,
} from './resumable-throughput.js';
import type { ResumableCircuitState } from './resumable-circuit-breaker.js';

const baseCircuit: ResumableCircuitState = {
  stallCount: 0,
  iterationCount: 5,
  startedAt: '2026-06-01T00:00:00.000Z',
  totalCostUsd: 0.5,
  lastProgress: { done: 60, cursor: 'page:5' },
};

describe('computeResumableThroughput (#1264)', () => {
  it('returns cold-start metrics when done is zero', () => {
    const metrics = computeResumableThroughput(
      { done: 0, total: 1300, lastSliceUnits: 0 },
      baseCircuit,
      new Date('2026-06-01T01:00:00.000Z'),
    );
    expect(metrics.estimateAvailable).toBe(false);
    expect(metrics.unitsPerSlice).toBeNull();
    expect(metrics.costPerUnit).toBeNull();
    expect(metrics.etaSlices).toBeNull();
    expect(formatResumableThroughputForResume(metrics)).toContain('no estimate yet');
  });

  it('returns cold-start metrics when circuit is absent', () => {
    const metrics = computeResumableThroughput(
      { done: 12, total: 1300, lastSliceUnits: 12 },
      null,
    );
    expect(metrics.estimateAvailable).toBe(false);
  });

  it('computes units/slice, cost/unit, and ETA from resumable + circuit', () => {
    const metrics = computeResumableThroughput(
      { done: 60, total: 1300, lastSliceUnits: 12 },
      baseCircuit,
      new Date('2026-06-01T01:00:00.000Z'),
    );

    expect(metrics.estimateAvailable).toBe(true);
    expect(metrics.unitsPerSlice).toBe(12);
    expect(metrics.unitsPerWallclockMinute).toBe(1);
    expect(metrics.costPerUnit).toBeCloseTo(0.5 / 60);
    expect(metrics.etaSlices).toBeCloseTo((1300 - 60) / 12);
    expect(metrics.etaWallclockMinutes).toBeCloseTo(1300 - 60);
  });

  it('formats resume guidance with averages and ETA', () => {
    const metrics = computeResumableThroughput(
      { done: 60, total: 1300, lastSliceUnits: 12 },
      baseCircuit,
      new Date('2026-06-01T01:00:00.000Z'),
    );
    const line = formatResumableThroughputForResume(metrics);
    expect(line).toContain('units/slice avg');
    expect(line).toContain('units/min wallclock');
    expect(line).toContain('/unit');
    expect(line).toContain('ETA');
  });
});

describe('emitResumableThroughputTelemetry', () => {
  it('logs and rethrows when audit publish fails', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const publishError = new Error('audit down');
    const bus = { publish: vi.fn().mockRejectedValue(publishError) };

    await expect(emitResumableThroughputTelemetry({
      logger: logger as never,
      bus: bus as never,
      taskId: 'task-1',
      agentId: 'social-media',
      resumable: { done: 60, total: 1300, lastSliceUnits: 12 },
      circuit: baseCircuit,
      now: new Date('2026-06-01T01:00:00.000Z'),
    })).rejects.toThrow('audit down');

    expect(logger.info).toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalledWith('system', expect.objectContaining({ type: 'task.resumable_throughput' }));
    expect(logger.error).toHaveBeenCalled();
  });
});
