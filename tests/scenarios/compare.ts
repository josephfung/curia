// tests/scenarios/compare.ts — usage comparison over two scenario results JSONs (#2764).
//
//   pnpm scenarios:compare <baseline.json> <branch.json>
//
// Per case: pass rate, strict pass rate, case-agent calls, input tokens (uncached /
// cached / total), p50 duration, skills activated by path. Flags cases outside the
// Layer 2 thresholds from the #2764 design. Exit 1 when any case is flagged.
//
// UsageTotals.inputTokens already excludes cache reads (Anthropic meaning). Uncached
// is that field; total input for the −40% gate is uncached + cacheRead + cacheCreation.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CaseResult, SuiteResult } from './types.js';
import type { UsageTotals } from '../shared/usage.js';

const COORDINATOR = 'coordinator';

export interface CompareThresholds {
  /** Branch total input tokens must be ≤ baseline × this on live turns (default 0.60 = −40%). */
  maxInputTokenRatio: number;
  /** Branch median case-agent calls may rise by at most this on live turns (default 0.5). */
  maxCallsDelta: number;
  /** Branch p50 duration must be ≤ baseline × this (default 1.10 = +10%). */
  maxDurationRatio: number;
}

export const DEFAULT_THRESHOLDS: CompareThresholds = {
  maxInputTokenRatio: 0.6,
  maxCallsDelta: 0.5,
  maxDurationRatio: 1.1,
};

export interface CaseCompareRow {
  name: string;
  baseline: CaseMetrics;
  branch: CaseMetrics;
  flags: string[];
}

export interface CaseMetrics {
  passRate: number;
  strictPassRate: number;
  /** Mean calls by the case agent (coordinator or specialist). */
  agentCalls: number;
  /** @deprecated Alias of agentCalls for older call sites; prefer agentCalls. */
  coordinatorCalls: number;
  /** Uncached input (UsageTotals.inputTokens — already excludes cache reads). */
  uncachedInputTokens: number;
  cachedInputTokens: number;
  /** Uncached + cacheRead + cacheCreation — the §10 live-turn input measure. */
  totalInputTokens: number;
  /** @deprecated Alias of totalInputTokens. */
  inputTokens: number;
  p50DurationMs: number;
  skillsByPath: Record<string, string[]>;
  /** Case agent id used for the metrics (default coordinator). */
  agent: string;
  scheduled: boolean;
  runCount: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function isScheduled(caseResult: CaseResult): boolean {
  return (caseResult.tags ?? []).includes('scheduler');
}

function agentTotals(caseResult: CaseResult): UsageTotals | undefined {
  const agent = caseResult.agent ?? COORDINATOR;
  const byAgent = caseResult.usage.byAgent;
  if (byAgent[agent]) return byAgent[agent];
  // Older results without `agent`: prefer coordinator, else the sole agent key.
  if (byAgent[COORDINATOR]) return byAgent[COORDINATOR];
  const keys = Object.keys(byAgent);
  return keys.length === 1 ? byAgent[keys[0]!] : undefined;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function caseMetrics(caseResult: CaseResult): CaseMetrics {
  const totals = agentTotals(caseResult);
  const runCount = Math.max(caseResult.runs.length, 1);
  // UsageTotals.inputTokens is already uncached (Anthropic meaning).
  const uncached = (totals?.inputTokens ?? 0) / runCount;
  const cached = (totals?.cacheReadInputTokens ?? 0) / runCount;
  const cacheCreation = (totals?.cacheCreationInputTokens ?? 0) / runCount;
  const totalInput = uncached + cached + cacheCreation;
  const perRunCalls = (totals?.calls ?? 0) / runCount;
  const skillsByPath: Record<string, string[]> = {};
  for (const run of caseResult.runs) {
    for (const a of run.skillActivations ?? []) {
      const list = skillsByPath[a.by] ?? (skillsByPath[a.by] = []);
      if (!list.includes(a.skill)) list.push(a.skill);
    }
  }
  for (const list of Object.values(skillsByPath)) list.sort();
  const passRates = caseResult.behaviors.map(b => b.passRate);
  const strictRates = caseResult.behaviors.map(b => b.strictPassRate);
  const agent = caseResult.agent ?? COORDINATOR;
  return {
    passRate: mean(passRates),
    strictPassRate: mean(strictRates),
    agentCalls: perRunCalls,
    coordinatorCalls: perRunCalls,
    uncachedInputTokens: uncached,
    cachedInputTokens: cached,
    totalInputTokens: totalInput,
    inputTokens: totalInput,
    p50DurationMs: median(caseResult.runs.map(r => r.durationMs)),
    skillsByPath,
    agent,
    scheduled: isScheduled(caseResult),
    runCount,
  };
}

export function compareCases(
  baseline: SuiteResult,
  branch: SuiteResult,
  thresholds: CompareThresholds = DEFAULT_THRESHOLDS,
): CaseCompareRow[] {
  const baseByName = new Map(baseline.cases.map(c => [c.name, c]));
  const branchByName = new Map(branch.cases.map(c => [c.name, c]));
  const names = [...new Set([...baseByName.keys(), ...branchByName.keys()])].sort();
  const rows: CaseCompareRow[] = [];
  for (const name of names) {
    const baseCase = baseByName.get(name);
    const branchCase = branchByName.get(name);
    if (!baseCase || !branchCase) {
      rows.push({
        name,
        baseline: baseCase ? caseMetrics(baseCase) : emptyMetrics(),
        branch: branchCase ? caseMetrics(branchCase) : emptyMetrics(),
        flags: [baseCase ? 'missing on branch' : 'missing on baseline'],
      });
      continue;
    }
    const base = caseMetrics(baseCase);
    const next = caseMetrics(branchCase);
    const flags: string[] = [];
    const runs = Math.max(base.runCount, next.runCount, 1);
    // §10: branch pass rate falls no more than one run (of N) below baseline.
    if (next.passRate + 1e-9 < base.passRate - 1 / runs) {
      flags.push(
        `pass rate ${(next.passRate * 100).toFixed(0)}% < ${(base.passRate * 100).toFixed(0)}% − 1/${runs}`,
      );
    }
    if (base.scheduled || next.scheduled) {
      // Scheduled: calls must not rise; −40% token rule does not apply.
      if (next.agentCalls > base.agentCalls + 1e-9) {
        flags.push(
          `scheduled calls ${fmt(next.agentCalls)} > ${fmt(base.agentCalls)} (no increase allowed)`,
        );
      }
    } else {
      if (base.totalInputTokens > 0
        && next.totalInputTokens > base.totalInputTokens * thresholds.maxInputTokenRatio) {
        flags.push(
          `total input ${fmt(next.totalInputTokens)} > ${fmt(base.totalInputTokens)} × ${thresholds.maxInputTokenRatio}`,
        );
      }
      if (next.agentCalls > base.agentCalls + thresholds.maxCallsDelta) {
        flags.push(
          `${base.agent} calls ${fmt(next.agentCalls)} > ${fmt(base.agentCalls)} + ${thresholds.maxCallsDelta}`,
        );
      }
    }
    if (base.p50DurationMs > 0
      && next.p50DurationMs > base.p50DurationMs * thresholds.maxDurationRatio) {
      flags.push(
        `p50 duration ${Math.round(next.p50DurationMs)}ms > ${Math.round(base.p50DurationMs)}ms × ${thresholds.maxDurationRatio}`,
      );
    }
    rows.push({ name, baseline: base, branch: next, flags });
  }
  return rows;
}

function emptyMetrics(): CaseMetrics {
  return {
    passRate: 0,
    strictPassRate: 0,
    agentCalls: 0,
    coordinatorCalls: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    totalInputTokens: 0,
    inputTokens: 0,
    p50DurationMs: 0,
    skillsByPath: {},
    agent: COORDINATOR,
    scheduled: false,
    runCount: 1,
  };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function loadSuite(file: string): SuiteResult {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as SuiteResult;
  if (!raw || !Array.isArray(raw.cases)) {
    throw new Error(`${file}: expected a SuiteResult with a cases array`);
  }
  return raw;
}

function formatSkills(byPath: Record<string, string[]>): string {
  const keys = Object.keys(byPath).sort();
  if (keys.length === 0) return '—';
  return keys.map(k => `${k}:[${byPath[k]!.join(',')}]`).join(' ');
}

function main(argv: string[]): number {
  const positional = argv.filter(a => !a.startsWith('--'));
  if (positional.length !== 2) {
    process.stderr.write('Usage: pnpm scenarios:compare <baseline.json> <branch.json>\n');
    return 1;
  }
  const baselinePath = path.resolve(process.env['INIT_CWD'] ?? process.cwd(), positional[0]!);
  const branchPath = path.resolve(process.env['INIT_CWD'] ?? process.cwd(), positional[1]!);
  const rows = compareCases(loadSuite(baselinePath), loadSuite(branchPath));
  const flagged = rows.filter(r => r.flags.length > 0);
  process.stdout.write(`Comparing ${path.basename(baselinePath)} → ${path.basename(branchPath)} (${rows.length} case(s))\n`);
  process.stdout.write(
    `${'case'.padEnd(40)} ${'pass'.padStart(6)} ${'strict'.padStart(6)} ${'calls'.padStart(7)} ${'totalIn'.padStart(10)} ${'p50ms'.padStart(8)}  skills / flags\n`,
  );
  for (const row of rows) {
    const b = row.branch;
    const line =
      `${row.name.slice(0, 40).padEnd(40)} ` +
      `${(b.passRate * 100).toFixed(0).padStart(5)}% ` +
      `${(b.strictPassRate * 100).toFixed(0).padStart(5)}% ` +
      `${fmt(b.agentCalls).padStart(7)} ` +
      `${fmt(b.totalInputTokens).padStart(10)} ` +
      `${String(Math.round(b.p50DurationMs)).padStart(8)}  ` +
      `${formatSkills(b.skillsByPath)}` +
      (row.flags.length > 0 ? `  !! ${row.flags.join('; ')}` : '');
    process.stdout.write(`${line}\n`);
  }
  if (flagged.length > 0) {
    process.stderr.write(`\n${flagged.length} case(s) outside thresholds.\n`);
    return 1;
  }
  process.stdout.write('\nAll cases within thresholds.\n');
  return 0;
}

const invokedAsCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsCli) {
  process.exit(main(process.argv.slice(2)));
}
