// tests/shared/rejudge-cli.ts — `pnpm rejudge --judge <model> <results.json>...` (#1980).
//
// Re-judges the transcripts a smoke or scenario run saved (tests/smoke/results/*.json,
// tests/scenarios/results/*.json) with a candidate judge model, and reports how often its
// verdicts match the judge that produced the file. No agent runs: only judge calls are
// paid for, at the candidate's price.
//
//   pnpm rejudge --judge google/gemini-3.1-flash-lite tests/smoke/results/<run>.json
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
import type { RunRating, SuiteResult } from '../scenarios/types.js';
import { evaluateCases } from '../smoke/evaluator.js';
import type { RunResult } from '../smoke/types.js';
import { DEFAULT_CONCURRENCY, parseConcurrency, runConcurrently } from './case-scope.js';
import { formatAgreement, meetsBar, summarize, type CaseComparison, type RatingPair } from './rejudge.js';
import { emptyBreakdown, formatUsd, sumBreakdowns, UsageLedger, type UsageBreakdown } from './usage.js';

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

/** Smoke: one transcript per case; the verdict is the case's gate result. */
async function rejudgeSmoke(run: RunResult, judge: Judge, concurrency: number): Promise<Rejudged> {
  // An errored case was never judged, and a judge error has placeholder scores: neither
  // says anything about how the baseline judge rated the transcript.
  const judged = run.cases.filter(c => !c.error && !c.judgeError);
  const skipped = run.cases.length - judged.length;
  if (skipped > 0) out(`   Skipped ${skipped} case(s) the baseline never judged (errored, or a judge error)`);
  if (!run.today) err('  [WARN] this results file predates `today`; the candidate judges relative dates without it');
  const untargeted = judged.filter(c => c.testCase.target && !c.target);
  if (untargeted.length > 0) {
    err(`  [WARN] ${untargeted.length} targeted case(s) predate the saved target; the candidate sees unresolved placeholders in their thread`);
  }
  const results = await evaluateCases(
    judged.map(c => ({
      testCase: c.testCase,
      ...(c.target ? { target: c.target } : {}),
      responses: c.responses,
      agentCalls: c.agentCalls,
      usage: emptyBreakdown(),
      providerRetries: [],
    })),
    judge,
    { ...(run.today ? { today: run.today } : {}), concurrency },
  );
  const comparisons = judged.map((before, i): CaseComparison => {
    const after = results[i]!;
    const ratings: RatingPair[] = before.scores.map((b) => {
      const a = after.scores.find(s => s.behaviorId === b.behaviorId);
      return {
        behaviorId: b.behaviorId,
        before: { rating: b.rating, justification: b.justification },
        after: a ? { rating: a.rating, justification: a.justification } : { rating: 'MISS', justification: '(no score)' },
      };
    });
    if (after.judgeError) err(`  [WARN] ${before.testCase.name}: the candidate judge errored (${after.judgeError})`);
    return { name: before.testCase.name, passedBefore: before.passed, passedAfter: after.passed, ratings };
  });
  return { comparisons, spend: sumBreakdowns(results.map(r => r.usage)) };
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
      let resolved: typeof behaviors;
      try {
        resolved = resolveRunPlaceholders(behaviors, run);
      } catch (e) {
        // A date placeholder in a run saved before runs carried a clock (#1958). Rating it
        // against today's dates would compare the wrong days, so the run is left out.
        err(`  [WARN] ${result.name} run ${i + 1}: ${e instanceof Error ? e.message : String(e)}; skipped`);
        undatedRuns++;
        continue;
      }
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
      const data = JSON.parse(readFileSync(file, 'utf-8')) as RunResult | SuiteResult;
      const isScenarios = 'runsPerCase' in data;
      out(`\n${file}`);
      out(`   ${isScenarios ? 'scenarios' : 'smoke'} run of ${data.timestamp} on ${data.model ?? 'configured routing'}; candidate judge ${args.judge}`);
      const { comparisons, spend } = isScenarios
        ? await rejudgeScenarios(data as SuiteResult, judge, args.concurrency)
        : await rejudgeSmoke(data as RunResult, judge, args.concurrency);
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
