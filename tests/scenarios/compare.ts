// tests/scenarios/compare.ts — usage comparison over two scenario results JSONs (#2764).
//
//   pnpm scenarios:compare <baseline.json> <branch.json>
//
// Per case: pass rate, strict pass rate, coordinator calls, input tokens (uncached /
// cached), p50 duration, skills activated by path. Flags cases outside the Layer 2
// thresholds from the #2764 design (input tokens −40%, coordinator calls +0.5,
// p50 duration +10%). Exit 1 when any case is flagged.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CaseResult, SuiteResult } from './types.js';
import type { UsageTotals } from '../shared/usage.js';

const COORDINATOR = 'coordinator';

export interface CompareThresholds {
  /** Branch uncached input tokens must be ≤ baseline × this (default 0.60 = −40%). */
  maxInputTokenRatio: number;
  /** Branch median coordinator calls may rise by at most this (default 0.5). */
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
  coordinatorCalls: number;
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  p50DurationMs: number;
  skillsByPath: Record<string, string[]>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function agentTotals(caseResult: CaseResult): UsageTotals | undefined {
  return caseResult.usage.byAgent[COORDINATOR];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function caseMetrics(caseResult: CaseResult): CaseMetrics {
  const totals = agentTotals(caseResult);
  const inputTokens = totals?.inputTokens ?? 0;
  const cachedInputTokens = totals?.cacheReadInputTokens ?? 0;
  const runCount = Math.max(caseResult.runs.length, 1);
  // usage is summed over the case's runs; report per-run means for the A/B.
  const perRunInput = inputTokens / runCount;
  const perRunCached = cachedInputTokens / runCount;
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
  return {
    passRate: mean(passRates),
    strictPassRate: mean(strictRates),
    coordinatorCalls: perRunCalls,
    inputTokens: perRunInput,
    uncachedInputTokens: Math.max(0, perRunInput - perRunCached),
    cachedInputTokens: perRunCached,
    p50DurationMs: median(caseResult.runs.map(r => r.durationMs)),
    skillsByPath,
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
    if (base.uncachedInputTokens > 0
      && next.uncachedInputTokens > base.uncachedInputTokens * thresholds.maxInputTokenRatio) {
      flags.push(
        `uncached input ${fmt(next.uncachedInputTokens)} > ${fmt(base.uncachedInputTokens)} × ${thresholds.maxInputTokenRatio}`,
      );
    }
    if (next.coordinatorCalls > base.coordinatorCalls + thresholds.maxCallsDelta) {
      flags.push(
        `coordinator calls ${fmt(next.coordinatorCalls)} > ${fmt(base.coordinatorCalls)} + ${thresholds.maxCallsDelta}`,
      );
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
    coordinatorCalls: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    p50DurationMs: 0,
    skillsByPath: {},
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
    `${'case'.padEnd(40)} ${'pass'.padStart(6)} ${'strict'.padStart(6)} ${'calls'.padStart(7)} ${'uncached'.padStart(10)} ${'p50ms'.padStart(8)}  skills / flags\n`,
  );
  for (const row of rows) {
    const b = row.branch;
    const line =
      `${row.name.slice(0, 40).padEnd(40)} ` +
      `${(b.passRate * 100).toFixed(0).padStart(5)}% ` +
      `${(b.strictPassRate * 100).toFixed(0).padStart(5)}% ` +
      `${fmt(b.coordinatorCalls).padStart(7)} ` +
      `${fmt(b.uncachedInputTokens).padStart(10)} ` +
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
