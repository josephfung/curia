// tests/scenarios/cli.ts — `pnpm scenarios`: run the coordinator scenario suite (#1956).
//
//   pnpm scenarios --model deepseek/deepseek-v4.1-flash          # release gate
//   pnpm scenarios --case transfer --runs 3                       # iterate on one case
//
// Exits 1 when any critical behavior passes fewer than 80% of its runs, a run errors,
// or a case's stubs left holes (refused calls over its allowance). See README.md.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { evaluateCheck } from './assertions.js';
import { formatPct, gateFailures, scoreCase } from './gate.js';
import { createScenarioHarness, otherDatabaseClients, RUN_TIMEOUT_MS, type ScenarioHarness } from './harness.js';
import { createJudge, judgeRun, type Judge } from './judge.js';
import { loadScenarioCases } from './loader.js';
import { mustStub } from './stub-layer.js';
import { coverageViolations, mergeCoverage, readCoverage, writeCoverage } from './stub-coverage.js';
import {
  DEFAULT_RUNS,
  type CaseResult,
  type RunRating,
  type ScenarioCase,
  type ScenarioRun,
  type SuiteResult,
} from './types.js';

const CASES_DIR = path.resolve(import.meta.dirname, 'cases');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');
const COVERAGE_FILE = path.resolve(import.meta.dirname, 'stub-coverage.json');

interface Args {
  model?: string;
  caseFilter?: string;
  tags?: string[];
  runs?: number;
  allowOtherConnections: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const runsRaw = value('--runs');
  const runs = runsRaw === undefined ? undefined : Number(runsRaw);
  if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) throw new Error('--runs must be a positive integer');
  return {
    model: value('--model'),
    caseFilter: value('--case'),
    tags: value('--tags')?.split(','),
    runs,
    allowOtherConnections: argv.includes('--allow-other-connections'),
  };
}

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

/**
 * Problems that would make a case measure the harness instead of the model, found
 * before any paid call: a stub for a tool the coordinator is not offered (a typo, or a
 * tool the registry did not load), or a `called` check on a side-effecting tool with no
 * stub — that call would always be refused, so the check could never pass for the
 * right reason.
 */
function staticProblems(cases: ScenarioCase[], harness: ScenarioHarness): string[] {
  const problems: string[] = [];
  for (const c of cases) {
    for (const tool of Object.keys(c.toolStubs)) {
      if (!harness.coordinatorTools.has(tool)) {
        problems.push(`${c.name}: stubs '${tool}', which the coordinator is not offered in this stack`);
      }
    }
    for (const b of c.expectedBehaviors) {
      if (b.check?.kind === 'called' && !c.toolStubs[b.check.tool] && mustStub(b.check.tool, harness.stack.toolRegistry)) {
        problems.push(`${c.name}: behavior '${b.id}' expects ${b.check.tool}, which has no stub and would be refused`);
      }
    }
  }
  return problems;
}

async function rateRuns(
  scenario: ScenarioCase,
  runs: ScenarioRun[],
  harness: ScenarioHarness,
  judge: Judge,
): Promise<Map<string, RunRating[]>> {
  const ratings = new Map<string, RunRating[]>(scenario.expectedBehaviors.map(b => [b.id, []]));
  const judged = scenario.expectedBehaviors.filter(b => !b.check);

  for (const run of runs) {
    if (run.error) {
      // A run that never finished demonstrates nothing; every behavior misses.
      for (const b of scenario.expectedBehaviors) {
        ratings.get(b.id)!.push({ rating: 'MISS', justification: `run errored: ${run.error}` });
      }
      continue;
    }
    const judgeScores = await judgeRun(scenario, run, judged, judge);
    for (const b of scenario.expectedBehaviors) {
      ratings.get(b.id)!.push(
        b.check
          ? evaluateCheck(b.check, run, { internalNames: harness.internalNames })
          : judgeScores.get(b.id)!,
      );
    }
  }
  return ratings;
}

function gitCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf-8' }).trim();
  } catch {
    // Not fatal — results are still useful without it — but say so: the release gate
    // records this SHA, and a silent blank would look like it was never captured.
    err('  [WARN] could not read the git commit (git rev-parse failed)');
    return undefined;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));

  let cases = loadScenarioCases(CASES_DIR);
  if (args.caseFilter) cases = cases.filter(c => c.name.toLowerCase().includes(args.caseFilter!.toLowerCase()));
  if (args.tags) cases = cases.filter(c => c.tags.some(t => args.tags!.includes(t)));
  if (cases.length === 0) {
    err('No scenario cases match the filters.');
    process.exit(1);
  }

  out('\nCoordinator scenario suite');
  out(`   ${cases.length} case(s); runs per case: ${args.runs ?? `per case, default ${DEFAULT_RUNS}`}`);
  out(`   Per-run timeout: ${Math.round(RUN_TIMEOUT_MS / 1000)}s (SCENARIO_TIMEOUT_MS)`);
  out('   Booting the test-mode stack...');

  let harness: ScenarioHarness;
  try {
    harness = await createScenarioHarness({ model: args.model });
  } catch (e) {
    err(`\nFailed to boot: ${e instanceof Error ? e.message : String(e)}`);
    err('Needs DATABASE_URL (migrated, with a principal), SECRET_ENCRYPTION_KEY, and the model\'s provider key in the vault (#911).');
    process.exit(1);
  }

  const model = args.model ?? harness.stack.yamlConfig.model_routing?.tiers.standard.model ?? 'configured routing';
  let exitCode = 0;
  try {
    const judge = createJudge(harness.stack.llmProviders);
    out(`   Model: ${model}`);
    out(`   Judge: ${judge.model} (OpenRouter)`);
    for (const warning of harness.stack.warnings) out(`   [WARN] ${warning}`);

    // A running instance would act on the entries and threads a run seeds.
    const others = await otherDatabaseClients(harness.stack);
    if (others.length > 0) {
      const list = others.map(o => `${o.application} ×${o.count}`).join(', ');
      if (!args.allowOtherConnections) {
        err(`\nOther clients are connected to this database (${list}).`);
        err('A running Curia instance would act on the rows a run seeds. Stop it (docker stop curia-curia-1),');
        err('or pass --allow-other-connections if these are not Curia (e.g. a psql session).');
        exitCode = 1;
        return;
      }
      out(`   [WARN] continuing with other clients connected: ${list}`);
    }

    const problems = staticProblems(cases, harness);
    if (problems.length > 0) {
      err('\nCase problems (fix before a paid run):');
      for (const p of problems) err(`   ${p}`);
      exitCode = 1;
      return;
    }

    out('\n-- Running --\n');
    const results: CaseResult[] = [];
    for (const scenario of cases) {
      const n = args.runs ?? scenario.runs ?? DEFAULT_RUNS;
      const runs: ScenarioRun[] = [];
      for (let i = 0; i < n; i++) {
        const run = await harness.runOnce(scenario, i);
        runs.push(run);
        const calls = run.toolCalls.map(c => c.disposition === 'refused' ? `${c.name}!` : c.name).join(', ') || 'no tools';
        out(`   ${scenario.name} [${i + 1}/${n}] ${run.error ? `ERROR ${run.error}` : `${Math.round(run.durationMs / 1000)}s — ${calls}`}`);
      }
      const result = scoreCase(scenario.name, scenario.expectedBehaviors, runs, await rateRuns(scenario, runs, harness, judge));
      results.push(result);
      for (const b of result.behaviors) {
        const flag = result.criticalFailures.includes(b.behavior.id) ? 'FAIL' : b.passRate >= 0.8 ? 'ok  ' : 'low ';
        out(`      ${flag} ${formatPct(b.passRate).padStart(4)}  ${b.behavior.id} [${b.behavior.weight}]`);
        if (b.passRate < 1) {
          const firstMiss = b.ratings.find(r => r.rating !== 'PASS');
          if (firstMiss) out(`             e.g. ${firstMiss.justification.slice(0, 220)}`);
        }
      }
    }

    // Stub coverage: record this measurement, then gate on it.
    const coverage = mergeCoverage(
      readCoverage(COVERAGE_FILE),
      results.map(r => ({ name: r.name, model, runs: r.runs })),
    );
    writeCoverage(COVERAGE_FILE, coverage);
    const failures = [
      ...gateFailures(results),
      ...coverageViolations(results.map(r => r.name), coverage, { strict: true }),
    ];

    const suite: SuiteResult = {
      timestamp: new Date(started).toISOString(),
      model,
      commit: gitCommit(),
      runsPerCase: args.runs ?? DEFAULT_RUNS,
      cases: results,
      passed: failures.length === 0,
      gateFailures: failures,
      durationMs: Date.now() - started,
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    const resultsFile = path.join(RESULTS_DIR, `${suite.timestamp.replace(/[:.]/g, '-')}.json`);
    writeFileSync(resultsFile, JSON.stringify(suite, null, 2));

    out('\n-- Summary --\n');
    for (const r of results) {
      out(`   ${r.criticalFailures.length === 0 ? 'PASS' : 'FAIL'} ${formatPct(r.weightedScore).padStart(4)}  ${r.name}`);
    }
    out(`\n   Commit:  ${suite.commit ?? '(unknown)'}`);
    out(`   Model:   ${model}`);
    out(`   Results: ${resultsFile}`);
    out(`   Time:    ${Math.round(suite.durationMs / 1000)}s`);
    if (failures.length > 0) {
      out('\n   GATE FAILED:');
      for (const f of failures) out(`   - ${f}`);
      exitCode = 1;
    } else {
      out('\n   Gate passed.');
    }
  } catch (e) {
    // Without this, the process.exit in finally would swallow the error and exit 0 —
    // a crashed gate reporting success.
    err(`\nFatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    exitCode = 1;
  } finally {
    try {
      await harness.shutdown();
    } catch (e) {
      err(`  [WARN] shutdown error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // In finally so the early `return`s above (busy database, case problems) still
    // exit non-zero instead of falling off the end of main().
    process.exit(exitCode);
  }
}

main().catch((e: unknown) => {
  err(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
