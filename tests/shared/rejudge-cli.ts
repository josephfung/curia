// tests/shared/rejudge-cli.ts — `pnpm rejudge --judge <model> <results.json>...` (#1980).
//
// Re-judges the transcripts a scenario run saved (tests/scenarios/results/*.json) with a
// candidate judge model, and reports how often its verdicts match the judge that produced
// the file. No agent runs: only judge calls are paid for, at the candidate's price.
//
//   pnpm rejudge --judge google/gemini-3.1-flash-lite tests/scenarios/results/<run>.json
//
// The bar for switching judges is in rejudge.ts (REJUDGE_AGREEMENT_BAR). Exit code is 0
// either way: this is a report for a person, and every disagreement needs reading.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createTestModeStack } from '../../src/startup/test-mode-stack.js';
import { createJudge, type Judge } from '../scenarios/judge.js';
import { judgeRun } from '../scenarios/judge.js';
import { scoreCase, JUDGE_ERROR_PREFIX } from '../scenarios/gate.js';
import { loadScenarioCases, resolveRunPlaceholders } from '../scenarios/loader.js';
import { hasDatePlaceholders } from './date-placeholders.js';
import type { RunRating, SuiteResult } from '../scenarios/types.js';
import { DEFAULT_CONCURRENCY, parseConcurrency, runConcurrently } from './case-scope.js';
import { formatAgreement, meetsBar, summarize, type CaseComparison, type RatingPair } from './rejudge.js';
import { emptyBreakdown, formatUsd, UsageLedger, type UsageBreakdown } from './usage.js';

const SCENARIO_CASES_DIR = path.resolve(import.meta.dirname, '../scenarios/cases');

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

interface Args {
  judge: string;
  concurrency: number;
  files: string[];
}

function parseArgs(argv: string[]): Args {
  let judge: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--judge' || a === '--concurrency') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--judge') judge = v;
      else concurrency = parseConcurrency(v);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag '${a}' — expected --judge or --concurrency`);
    } else {
      files.push(a);
    }
  }
  if (!judge) throw new Error('--judge <model> is required (the candidate judge model)');
  if (files.length === 0) throw new Error('name at least one results file');
  return { judge, concurrency, files };
}

/** What a re-judge found, and what the candidate judge spent finding it. */
interface Rejudged {
  comparisons: CaseComparison[];
  spend: UsageBreakdown;
}

/**
 * Scenarios: each run's judged behaviors are re-rated; checked behaviors keep their
 * ratings. The verdict is whether the case had no critical failure (known-failure
 * markers aside, so a changed verdict on a marked case still shows).
 */
async function rejudgeScenarios(suite: SuiteResult, judge: Judge, concurrency: number): Promise<Rejudged> {
  const usage = new UsageLedger();
  const byName = new Map(loadScenarioCases(SCENARIO_CASES_DIR).map(c => [c.name, c]));
  let skippedRuns = 0;
  let undatedRuns = 0;
  const comparisons = await runConcurrently(suite.cases, concurrency, async (saved): Promise<CaseComparison | undefined> => {
    // Files saved before #1980 have no per-run spend; scoreCase sums it.
    const result = { ...saved, runs: saved.runs.map(r => ({ ...r, usage: r.usage ?? emptyBreakdown(), providerRetries: r.providerRetries ?? [] })) };
    const scenario = byName.get(result.name);
    if (!scenario) {
      err(`  [WARN] ${result.name}: no such case in ${SCENARIO_CASES_DIR} any more; skipped`);
      return undefined;
    }
    // The behaviors as the run saved them, so a case edited since cannot shift ids.
    const behaviors = result.behaviors.map(b => b.behavior);
    const after = new Map<string, RunRating[]>(result.behaviors.map(b => [b.behavior.id, [...b.ratings]]));
    const ratings: RatingPair[] = [];
    for (const [i, run] of result.runs.entries()) {
      if (run.error) continue;
      // A run saved before runs carried a clock (#1958) cannot resolve date placeholders.
      // Rating it against today's dates would compare the wrong days, so it is left out.
      // Any other resolution error is a real problem and still throws.
      if (!run.clock && hasDatePlaceholders(behaviors)) {
        err(`  [WARN] ${result.name} run ${i + 1}: saved without a clock for its date placeholders; skipped`);
        undatedRuns++;
        continue;
      }
      const resolved = resolveRunPlaceholders(behaviors, run);
      const judged = resolved.filter(b => !b.check);
      const before = (id: string): RunRating => result.behaviors.find(b => b.behavior.id === id)!.ratings[i]!;
      if (judged.length === 0) continue;
      if (judged.some(b => before(b.id).justification.startsWith(JUDGE_ERROR_PREFIX))) {
        skippedRuns++;
        continue;
      }
      const rerated = await judgeRun(scenario, run, judged, judge, usage);
      for (const b of judged) {
        const next = rerated.get(b.id)!;
        after.get(b.id)![i] = next;
        ratings.push({ behaviorId: b.id, run: i + 1, before: before(b.id), after: next });
      }
    }
    const rescored = scoreCase(result.name, behaviors, result.runs, after);
    return {
      name: result.name,
      passedBefore: result.criticalFailures.length === 0,
      passedAfter: rescored.criticalFailures.length === 0,
      ratings,
    };
  });
  if (skippedRuns > 0) out(`   Skipped ${skippedRuns} run(s) the baseline judge errored on`);
  if (undatedRuns > 0) out(`   Skipped ${undatedRuns} run(s) saved without a clock for their date placeholders`);
  return { comparisons: comparisons.filter((c): c is CaseComparison => c !== undefined), spend: usage.snapshot() };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    err(`rejudge: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // Only for the vault's OpenRouter key: the judge goes through the stack's provider (#911).
  const stack = await createTestModeStack({});
  let exitCode = 0;
  try {
    const judge = createJudge(stack.llmProviders, undefined, { model: args.judge, logger: stack.logger });
    const principal = stack.principalContactId ? await stack.contactService.getContact(stack.principalContactId) : undefined;
    if (principal) judge.principalName = principal.displayName;

    for (const file of args.files) {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as SuiteResult;
      // Smoke results files (no runsPerCase) predate smoke's retirement; they can't be re-judged.
      if (!('runsPerCase' in data)) throw new Error(`${file} is not a scenario results file`);
      out(`\n${file}`);
      out(`   scenarios run of ${data.timestamp} on ${data.model ?? 'configured routing'}; candidate judge ${args.judge}`);
      const { comparisons, spend } = await rejudgeScenarios(data, judge, args.concurrency);
      const agreement = summarize(comparisons);
      out('');
      for (const line of formatAgreement(agreement, args.judge, 'baseline')) out(`   ${line}`);
      const baselineSpend = data.usage?.judge.estimatedCostUsd;
      out('');
      out(`   Candidate judge spend: ${formatUsd(spend.judge.estimatedCostUsd)} (${spend.judge.calls} calls)` +
        (baselineSpend !== undefined ? ` (baseline judge spent ${formatUsd(baselineSpend)} on the same run, retries included)` : ''));
      out(meetsBar(agreement)
        ? '   Meets the agreement bar. Review every verdict change above before switching.'
        : '   Below the agreement bar: keep the current judge.');
    }
  } catch (e) {
    err(`rejudge: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    exitCode = 1;
  } finally {
    await stack.shutdown();
  }
  process.exit(exitCode);
}

main().catch((e: unknown) => {
  err(`rejudge: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
