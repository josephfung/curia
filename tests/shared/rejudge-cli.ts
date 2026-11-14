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
//
// --from-cases (#2556) scores a scenario run's transcripts against the behaviors in the
// current case files instead (checks re-evaluated, the rest judged by each case's own judge
// unless --judge names one), and saves the re-scored results beside the original:
//
//   pnpm rejudge --from-cases tests/scenarios/results/<run>.json
//
// It refuses, by name, every case whose setup changed since the run (setup-hash.ts), and
// then exits 1: those need a new run, not a new score. Judge errors also exit 1, and a case
// whose judge differs from the one that rated the run is flagged.
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createTestModeStack } from '../../src/startup/test-mode-stack.js';
import { createJudge, JUDGE_MODEL, type Judge } from '../scenarios/judge.js';
import { judgeRun } from '../scenarios/judge.js';
import { formatCaseLayers, gateFailures, knownFailureLines, scoreCase, JUDGE_ERROR_PREFIX } from '../scenarios/gate.js';
import { internalNamesFor } from '../scenarios/assertions.js';
import { caseJudgeModel } from '../scenarios/judge-models.js';
import { loadScenarioCases, resolveRunPlaceholders } from '../scenarios/loader.js';
import { rescoreCase, rescoreRefusal, type Rescored } from '../scenarios/rescore.js';
import { hasDatePlaceholders } from './date-placeholders.js';
import type { CaseResult, RunRating, ScenarioCase, SuiteResult } from '../scenarios/types.js';
import { evaluateCases } from '../smoke/evaluator.js';
import type { RunResult } from '../smoke/types.js';
import { DEFAULT_CONCURRENCY, parseConcurrency, runConcurrently } from './case-scope.js';
import { formatAgreement, meetsBar, summarize, type CaseComparison, type RatingPair } from './rejudge.js';
import { emptyBreakdown, formatUsd, sumBreakdowns, UsageLedger, type UsageBreakdown } from './usage.js';

const SCENARIO_CASES_DIR = path.resolve(import.meta.dirname, '../scenarios/cases');

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

interface Args {
  /** The candidate judge. Optional with --from-cases, where each case's own judge is the default. */
  judge?: string;
  concurrency: number;
  files: string[];
  /** Score against the current case files' behaviors instead of the saved ones (#2556). */
  fromCases: boolean;
}

function parseArgs(argv: string[]): Args {
  let judge: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  let fromCases = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--judge' || a === '--concurrency') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--judge') judge = v;
      else concurrency = parseConcurrency(v);
    } else if (a === '--from-cases') {
      fromCases = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag '${a}' — expected --judge, --concurrency or --from-cases`);
    } else {
      files.push(a);
    }
  }
  if (!judge && !fromCases) throw new Error('--judge <model> is required (the candidate judge model)');
  if (files.length === 0) throw new Error('name at least one results file');
  return { ...(judge ? { judge } : {}), concurrency, files, fromCases };
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

/**
 * --from-cases (#2556): score a scenario run's transcripts against the behaviors in the current
 * case files, report what moved, and save the re-scored results beside the original. Cases
 * whose setup changed since the run are refused by name: they need a new run.
 * Returns whether every case was re-scored cleanly: none refused, and no judge errors.
 */
async function rescoreFromCases(
  file: string,
  suite: SuiteResult,
  judgeFor: (scenario: ScenarioCase) => Judge,
  internalNames: string[],
  concurrency: number,
): Promise<boolean> {
  const usage = new UsageLedger();
  const byName = new Map(loadScenarioCases(SCENARIO_CASES_DIR).map(c => [c.name, c]));
  const refusals: string[] = [];

  // Every judge first, before any paid call: an unpriced judge_model stops the command here,
  // not after earlier cases have spent. And a judge that differs from the one that rated the
  // run would move verdicts by itself, which would read as the rubric's doing: say so.
  const judgeChanges: string[] = [];
  const usedJudges: Record<string, string> = {};
  for (const saved of suite.cases) {
    const scenario = byName.get(saved.name);
    if (!scenario) continue;
    const now = judgeFor(scenario).model;
    usedJudges[saved.name] = now;
    const before = suite.caseJudges?.[saved.name] ?? suite.judge;
    if (before !== now) judgeChanges.push(`${saved.name}: ${before ?? '(not recorded)'} → ${now}`);
  }
  const rescored = await runConcurrently(suite.cases, concurrency, async (saved): Promise<{ saved: CaseResult; now: Rescored } | undefined> => {
    const scenario = byName.get(saved.name);
    if (!scenario) {
      refusals.push(`${saved.name}: no such case in ${SCENARIO_CASES_DIR} any more`);
      return undefined;
    }
    // Files saved before #1980 have no per-run spend; scoreCase sums it.
    const withUsage: CaseResult = { ...saved, runs: saved.runs.map(r => ({ ...r, usage: r.usage ?? emptyBreakdown(), providerRetries: r.providerRetries ?? [] })) };
    const refusal = rescoreRefusal(withUsage, scenario);
    if (refusal) {
      refusals.push(refusal);
      return undefined;
    }
    const judge = judgeFor(scenario);
    const now = await rescoreCase(withUsage, scenario, (s, run, behaviors) => judgeRun(s, run, behaviors, judge, usage), internalNames);
    return { saved: withUsage, now };
  });
  const done = rescored.filter((r): r is { saved: CaseResult; now: Rescored } => r !== undefined);

  // A rating either judge failed to produce compares nothing: leave it out, and report the
  // new run's judge errors on their own, so a rate-limited judge never reads as a rubric
  // that fails Curia.
  const judgeFailed = (r: RunRating): boolean => r.justification.startsWith(JUDGE_ERROR_PREFIX);
  const comparisons: CaseComparison[] = done.map(({ saved, now }) => ({
    name: saved.name,
    passedBefore: saved.criticalFailures.length === 0,
    passedAfter: now.result.criticalFailures.length === 0,
    ratings: now.result.behaviors.flatMap(b => {
      const old = saved.behaviors.find(s => s.behavior.id === b.behavior.id);
      return old
        ? b.ratings.flatMap((after, i) => (judgeFailed(after) || judgeFailed(old.ratings[i]!) ? [] : [{ behaviorId: b.behavior.id, run: i + 1, before: old.ratings[i]!, after }]))
        : [];
    }),
  }));
  if (judgeChanges.length > 0) {
    out('');
    out('   [WARN] These cases are judged by a different model than rated the run, so a verdict change');
    out('   may be the judge\'s, not the case file\'s. Pass --judge <the run\'s judge> to hold it fixed:');
    for (const c of judgeChanges) out(`   - ${c}`);
  }
  out('');
  for (const line of formatAgreement(summarize(comparisons), 'current cases', 'saved')) out(`   ${line}`);
  const judgeErrored = done.filter(({ now }) => now.result.judgeErrors > 0);
  if (judgeErrored.length > 0) {
    out('');
    out('   Judge errors (those ratings are left out above; re-run the command):');
    for (const { now } of judgeErrored) out(`   - ${now.result.name}: ${now.result.judgeErrors} run(s)`);
  }
  const edits = done.filter(({ now }) => now.added.length + now.removed.length + now.edited.length > 0);
  if (edits.length > 0) {
    out('');
    out('   Behaviors changed in the case files since the run:');
    for (const { saved, now } of edits) {
      const parts = [
        ...(now.added.length > 0 ? [`added ${now.added.join(', ')}`] : []),
        ...(now.removed.length > 0 ? [`removed ${now.removed.join(', ')}`] : []),
        ...(now.edited.length > 0 ? [`edited ${now.edited.join(', ')}`] : []),
      ];
      out(`   - ${saved.name}: ${parts.join('; ')}`);
    }
  }
  const layered = done.filter(({ saved, now }) => saved.layers || now.result.layers);
  if (layered.length > 0) {
    out('');
    out('   Layer scores (saved → current cases):');
    for (const { saved, now } of layered) {
      out(`   - ${saved.name}: ${formatCaseLayers(saved) || '(none)'} → ${formatCaseLayers(now.result) || '(none)'}`);
    }
  }
  if (refusals.length > 0) {
    out('');
    out('   Not re-scored (run these again):');
    for (const r of refusals) out(`   - ${r}`);
  }

  const outFile = file.replace(/\.json$/, '') + `.rescored-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const cases = done.map(({ now }) => now.result);
  // The same reasons a live run gates on (known failures, judge errors, errored runs), plus
  // the refusals: `passed` is read from this list, so the two cannot disagree.
  const failures = [...gateFailures(cases), ...refusals];
  const judges = cases.map(c => usedJudges[c.name]!);
  const defaultJudge = judges.length > 0 && judges.every(j => j === judges[0]) ? judges[0] : suite.judge;
  const caseJudges = Object.fromEntries(cases.filter(c => usedJudges[c.name] !== defaultJudge).map(c => [c.name, usedJudges[c.name]!]));
  const result: SuiteResult = {
    ...suite,
    ...(defaultJudge !== undefined ? { judge: defaultJudge } : {}),
    caseJudges,
    cases,
    runsPerCase: Object.fromEntries(cases.map(c => [c.name, c.runs.length])),
    passed: failures.length === 0,
    knownFailures: knownFailureLines(cases),
    // The re-scored file is a scoring of old transcripts, not a run: say so where a reader looks.
    warnings: [
      ...suite.warnings,
      `re-scored against the case files at ${new Date().toISOString()} (pnpm rejudge --from-cases); transcripts are from ${suite.timestamp}`,
      ...judgeChanges.map(c => `judge changed since the run: ${c}`),
    ],
    gateFailures: failures,
  };
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  out('');
  out(`   Judge spend: ${formatUsd(usage.snapshot().judge.estimatedCostUsd)} (${usage.snapshot().judge.calls} calls)`);
  out(`   Re-scored results: ${outFile}`);
  return refusals.length === 0 && judgeErrored.length === 0;
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
    const principal = stack.principalContactId ? await stack.contactService.getContact(stack.principalContactId) : undefined;

    if (args.fromCases) {
      // Each case's own judge (judge-models.ts) unless --judge names one for all. Created once
      // per model; rescoreFromCases asks for every case's before any paid call.
      const judges = new Map<string, Judge>();
      const judgeFor = (scenario: ScenarioCase): Judge => {
        const model = args.judge ?? caseJudgeModel(scenario) ?? JUDGE_MODEL;
        if (!judges.has(model)) judges.set(model, createJudge(stack.llmProviders, principal?.displayName, { model, logger: stack.logger }));
        return judges.get(model)!;
      };
      const internalNames = internalNamesFor({
        tools: stack.toolRegistry.list().map(t => t.manifest.name),
        agents: stack.agentRegistry.list().map(a => a.name),
      });
      for (const file of args.files) {
        const data = JSON.parse(readFileSync(file, 'utf-8')) as RunResult | SuiteResult;
        if (!('runsPerCase' in data)) throw new Error(`${file}: --from-cases re-scores scenario results; this is a smoke run`);
        out(`\n${file}`);
        out(`   scenarios run of ${data.timestamp} on ${data.model ?? 'configured routing'}, commit ${data.commit ?? '(unknown)'}; scored against the current case files`);
        if (!(await rescoreFromCases(file, data, judgeFor, internalNames, args.concurrency))) exitCode = 1;
      }
      return;
    }

    const judge = createJudge(stack.llmProviders, undefined, { model: args.judge!, logger: stack.logger });
    if (principal) judge.principalName = principal.displayName;

    for (const file of args.files) {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as RunResult | SuiteResult;
      const isScenarios = 'runsPerCase' in data;
      out(`\n${file}`);
      out(`   ${isScenarios ? 'scenarios' : 'smoke'} run of ${data.timestamp} on ${data.model ?? 'configured routing'}; candidate judge ${judge.model}`);
      const { comparisons, spend } = isScenarios
        ? await rejudgeScenarios(data as SuiteResult, judge, args.concurrency)
        : await rejudgeSmoke(data as RunResult, judge, args.concurrency);
      const agreement = summarize(comparisons);
      out('');
      for (const line of formatAgreement(agreement, judge.model, 'baseline')) out(`   ${line}`);
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
