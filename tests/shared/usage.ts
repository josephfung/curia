// tests/shared/usage.ts — what a behavior-suite run spent on model calls (#1980).
//
// Agents' calls are counted from the runtime's own llm.call events (token counts and
// estimatedCostUsd, priced by the model registry). The judge is not an agent and publishes
// nothing, so the judge code meters its own responses into the same ledger.
//
// Reasoning tokens and latency come from the same llm.call payloads (ADR-048), so an A/B
// can compare them per agent. The judge's latency is not metered.
//
// Every figure is an ESTIMATE: registry list prices, not OpenRouter's bill. Two known gaps:
// - OpenRouter cache reads are reported as zero (#1962), so cached input is priced as
//   uncached and the estimate runs high wherever the provider caches.
// - A call that fails after the provider billed it publishes no llm.call, so it is missing.
// docs/dev/smoke-tests.md records how far one full run's estimate was from the bill.

/** Token and cost totals for a set of calls. */
export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedCostUsd: number;
  /** Reasoning tokens, a subset of outputTokens. 0 when no call reported any. */
  reasoningTokens: number;
  /** One latency sample per call that reported one, for p50/p90. */
  latenciesMs: number[];
}

/** One case's (or one run's) spend, split by who made the calls. */
export interface UsageBreakdown {
  /** Agents' calls, keyed by agent id (coordinator, calendar, …). */
  byAgent: Record<string, UsageTotals>;
  /** The judge's calls, retries included. */
  judge: UsageTotals;
  /** Everything above. */
  total: UsageTotals;
}

/** The token fields an llm.call payload (or an LLM response's usage) carries. */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** llm.call's reasoningTokens (null when not reported), or LLMUsage's. */
  reasoningTokens?: number | null;
  /** llm.call's latencyMs. LLM responses carry none. */
  latencyMs?: number;
}

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    estimatedCostUsd: 0,
    reasoningTokens: 0,
    latenciesMs: [],
  };
}

export function emptyBreakdown(): UsageBreakdown {
  return { byAgent: {}, judge: emptyTotals(), total: emptyTotals() };
}

function addCall(totals: UsageTotals, usage: CallUsage, costUsd: number): void {
  totals.calls += 1;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheReadInputTokens += usage.cacheReadInputTokens;
  totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  totals.estimatedCostUsd += costUsd;
  totals.reasoningTokens += usage.reasoningTokens ?? 0;
  if (typeof usage.latencyMs === 'number' && Number.isFinite(usage.latencyMs)) {
    totals.latenciesMs.push(usage.latencyMs);
  }
}

function addTotals(into: UsageTotals, from: UsageTotals): void {
  into.calls += from.calls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadInputTokens += from.cacheReadInputTokens;
  into.cacheCreationInputTokens += from.cacheCreationInputTokens;
  into.estimatedCostUsd += from.estimatedCostUsd;
  // Results saved before ADR-048's telemetry lack both fields; rejudge sums those too.
  into.reasoningTokens += from.reasoningTokens ?? 0;
  into.latenciesMs.push(...(from.latenciesMs ?? []));
}

/** Accumulates one case's calls as they happen. */
export class UsageLedger {
  private readonly usage = emptyBreakdown();

  addAgentCall(agentId: string, usage: CallUsage, costUsd: number): void {
    const totals = (this.usage.byAgent[agentId] ??= emptyTotals());
    addCall(totals, usage, costUsd);
    addCall(this.usage.total, usage, costUsd);
  }

  addJudgeCall(usage: CallUsage, costUsd: number): void {
    addCall(this.usage.judge, usage, costUsd);
    addCall(this.usage.total, usage, costUsd);
  }

  /** A copy: later calls must not change a result already written down. */
  snapshot(): UsageBreakdown {
    return structuredClone(this.usage);
  }
}

/** Several breakdowns added together (a case's runs, a suite's cases). */
export function sumBreakdowns(parts: readonly UsageBreakdown[]): UsageBreakdown {
  const sum = emptyBreakdown();
  for (const part of parts) {
    for (const [agent, totals] of Object.entries(part.byAgent)) addTotals((sum.byAgent[agent] ??= emptyTotals()), totals);
    addTotals(sum.judge, part.judge);
    addTotals(sum.total, part.total);
  }
  return sum;
}

/** "$1.23", or "$0.0042" below a cent so small cases don't all read "$0.00". */
export function formatUsd(value: number): string {
  return value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

/** "1.2M", "34.5k", "812". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Nearest-rank percentile (0–100) of the samples, or undefined when there are none. */
export function percentile(samples: readonly number[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** "3.6s / 21.0s" for p50 / p90 latency, or "—" with no samples. */
export function formatLatency(samples: readonly number[]): string {
  const p50 = percentile(samples, 50);
  const p90 = percentile(samples, 90);
  if (p50 === undefined || p90 === undefined) return '—';
  return `${(p50 / 1000).toFixed(1)}s / ${(p90 / 1000).toFixed(1)}s`;
}

/**
 * The summary lines both suites print: the total, then each agent and the judge, most
 * expensive first. Cache reads are shown because whether the coordinator's prefix is
 * cached is the biggest cost question (#1980) — and why "0 cached" may be #1962, not a miss.
 * Reasoning tokens and latency are what the ADR-048 A/Bs compare per agent.
 */
export function formatUsageLines(usage: UsageBreakdown): string[] {
  const line = (label: string, t: UsageTotals): string =>
    `${label.padEnd(18)} ${formatUsd(t.estimatedCostUsd).padStart(8)}  ${String(t.calls).padStart(5)} calls  ` +
    `${formatTokens(t.inputTokens).padStart(7)} in (${formatTokens(t.cacheReadInputTokens)} cached)  ` +
    `${formatTokens(t.outputTokens).padStart(7)} out (${formatTokens(t.reasoningTokens)} reasoning)  ` +
    `p50/p90 ${formatLatency(t.latenciesMs)}`;
  const all: Array<[string, UsageTotals]> = [...Object.entries(usage.byAgent), ['judge', usage.judge]];
  const parts = all.filter(([, t]) => t.calls > 0);
  parts.sort((a, b) => b[1].estimatedCostUsd - a[1].estimatedCostUsd);
  return [line('total (estimate)', usage.total), ...parts.map(([label, t]) => line(`  ${label}`, t))];
}
