// usage.test.ts — the behavior suites' spend ledger records reasoning tokens and
// latency per agent, which the ADR-048 A/Bs compare.

import { describe, it, expect } from 'vitest';
import {
  emptyBreakdown,
  formatLatency,
  formatUsageLines,
  percentile,
  sumBreakdowns,
  UsageLedger,
  type CallUsage,
  type UsageBreakdown,
} from '../../shared/usage.js';

function call(over: Partial<CallUsage> = {}): CallUsage {
  return { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ...over };
}

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
  });

  it('is undefined with no samples', () => {
    expect(percentile([], 50)).toBeUndefined();
  });
});

describe('formatLatency', () => {
  it('prints p50 / p90 in seconds', () => {
    expect(formatLatency([2000, 3600, 21000])).toBe('3.6s / 21.0s');
  });

  it('prints a dash with no samples', () => {
    expect(formatLatency([])).toBe('—');
  });
});

describe('UsageLedger', () => {
  it('sums reasoning tokens and keeps one latency sample per agent call', () => {
    const ledger = new UsageLedger();
    ledger.addAgentCall('coordinator', call({ reasoningTokens: 30, latencyMs: 1200 }), 0.01);
    ledger.addAgentCall('coordinator', call({ reasoningTokens: null, latencyMs: 800 }), 0.01);
    ledger.addAgentCall('calendar', call({ reasoningTokens: 5, latencyMs: 400 }), 0.01);
    const usage = ledger.snapshot();
    expect(usage.byAgent['coordinator']).toMatchObject({ calls: 2, reasoningTokens: 30, latenciesMs: [1200, 800] });
    expect(usage.byAgent['calendar']).toMatchObject({ reasoningTokens: 5, latenciesMs: [400] });
    expect(usage.total).toMatchObject({ calls: 3, reasoningTokens: 35, latenciesMs: [1200, 800, 400] });
  });

  it('counts the judge\'s reasoning, without latency', () => {
    const ledger = new UsageLedger();
    ledger.addJudgeCall(call({ reasoningTokens: 9 }), 0.001);
    expect(ledger.snapshot().judge).toMatchObject({ calls: 1, reasoningTokens: 9, latenciesMs: [] });
  });
});

describe('sumBreakdowns', () => {
  it('adds reasoning tokens and concatenates latency samples', () => {
    const a = new UsageLedger();
    a.addAgentCall('coordinator', call({ reasoningTokens: 10, latencyMs: 100 }), 0);
    const b = new UsageLedger();
    b.addAgentCall('coordinator', call({ reasoningTokens: 20, latencyMs: 300 }), 0);
    const sum = sumBreakdowns([a.snapshot(), b.snapshot()]);
    expect(sum.byAgent['coordinator']).toMatchObject({ reasoningTokens: 30, latenciesMs: [100, 300] });
  });

  it('accepts results saved before the reasoning fields existed', () => {
    const saved = JSON.parse(JSON.stringify({
      byAgent: { coordinator: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0 } },
      judge: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0 },
      total: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0 },
    })) as UsageBreakdown;
    const sum = sumBreakdowns([saved, emptyBreakdown()]);
    expect(sum.total).toMatchObject({ calls: 1, reasoningTokens: 0, latenciesMs: [] });
  });
});

describe('formatUsageLines', () => {
  it('prints reasoning tokens and latency for each agent', () => {
    const ledger = new UsageLedger();
    ledger.addAgentCall('coordinator', call({ reasoningTokens: 1500, latencyMs: 2000 }), 0.02);
    ledger.addAgentCall('coordinator', call({ reasoningTokens: 0, latencyMs: 4000 }), 0.02);
    const [total, coordinator] = formatUsageLines(ledger.snapshot());
    expect(total).toContain('(1.5k reasoning)');
    expect(coordinator).toContain('coordinator');
    expect(coordinator).toContain('p50/p90 2.0s / 4.0s');
  });
});
