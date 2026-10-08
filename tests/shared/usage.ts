// tests/shared/usage.ts — what a behavior-suite run spent on model calls (#1980).
//
// Agents' calls are counted from the runtime's own llm.call events (token counts and
// estimatedCostUsd, priced by the model registry). The judge is not an agent and publishes
// nothing, so the judge code meters its own responses into the same ledger.
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
}

export function emptyTotals(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0 };
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
}

function addTotals(into: UsageTotals, from: UsageTotals): void {
  into.calls += from.calls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadInputTokens += from.cacheReadInputTokens;
  into.cacheCreationInputTokens += from.cacheCreationInputTokens;
  into.estimatedCostUsd += from.estimatedCostUsd;
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

/**
 * The summary lines both suites print: the total, then each agent and the judge, most
 * expensive first. Cache reads are shown because whether the coordinator's prefix is
 * cached is the biggest cost question (#1980) — and why "0 cached" may be #1962, not a miss.
 */
export function formatUsageLines(usage: UsageBreakdown): string[] {
  const line = (label: string, t: UsageTotals): string =>
    `${label.padEnd(18)} ${formatUsd(t.estimatedCostUsd).padStart(8)}  ${String(t.calls).padStart(5)} calls  ` +
    `${formatTokens(t.inputTokens).padStart(7)} in (${formatTokens(t.cacheReadInputTokens)} cached)  ` +
    `${formatTokens(t.outputTokens).padStart(7)} out`;
  const all: Array<[string, UsageTotals]> = [...Object.entries(usage.byAgent), ['judge', usage.judge]];
  const parts = all.filter(([, t]) => t.calls > 0);
  parts.sort((a, b) => b[1].estimatedCostUsd - a[1].estimatedCostUsd);
  return [line('total (estimate)', usage.total), ...parts.map(([label, t]) => line(`  ${label}`, t))];
}
