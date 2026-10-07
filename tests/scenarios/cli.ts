// tests/scenarios/cli.ts — `pnpm scenarios`: run the coordinator scenario suite (#1956).
//
//   pnpm scenarios --model deepseek/deepseek-v4.1-flash          # release gate
//   pnpm scenarios --case transfer --runs 3                       # iterate on one case
//   pnpm scenarios --concurrency 1                                # one case at a time
//
// Cases run --concurrency at a time (default 4); a case's own runs stay one at a time,
// and cases that seed the same contact never overlap (seed.ts: seedConflictKeys). The
// summary prints what the run spent on model calls, by agent and judge (#1980).
//
// Exits 1 when any critical behavior passes fewer than 80% of its runs, a run errors,
// or a case's stubs left holes (refused calls over its allowance). See README.md.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { evaluateCheck, leafChecks } from './assertions.js';
import { formatPct, gateFailures, knownFailureLines, scoreCase, staleKnownFailures } from './gate.js';
import {
  acquireSuiteLock,
  createScenarioHarness,
  otherDatabaseClients,
  RUN_TIMEOUT_MS,
  type ScenarioHarness,
} from './harness.js';
import { createJudge, judgeRun, type Judge } from './judge.js';
import { loadScenarioCases, resolveRunPlaceholders } from './loader.js';
import { describeError, seedConflictKeys } from './seed.js';
import { DEFAULT_CONCURRENCY, parseConcurrency, runConcurrently } from '../shared/case-scope.js';
import { formatUsageLines, formatUsd, sumBreakdowns, UsageLedger } from '../shared/usage.js';
import { mustStub } from './stub-layer.js';
import { coverageViolations, mergeCoverage, readCoverage, writeCoverage } from './stub-coverage.js';
import {
  CRITICAL_PASS_THRESHOLD,
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
  concurrency: number;
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
  const concurrencyRaw = value('--concurrency');
  return {
    model: value('--model'),
    caseFilter: value('--case'),
    tags: value('--tags')?.split(','),
    runs,
    concurrency: concurrencyRaw === undefined ? DEFAULT_CONCURRENCY : parseConcurrency(concurrencyRaw),
    allowOtherConnections: argv.includes('--allow-other-connections'),
  };
}

const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

/**
 * Problems that would make a case measure the harness instead of the model, found
 * before any paid call: a stub for a tool the coordinator can never reach (a typo, or a
 * tool the registry did not load), or a `called` check on a side-effecting tool with no
 * stub — that call would always be refused, so the check could never pass for the
 * right reason. "Reach" includes tools a skill-activate call would load (#2024).
 */
function staticProblems(cases: ScenarioCase[], harness: ScenarioHarness): string[] {
  const problems: string[] = [];
  const registry = harness.stack.toolRegistry;
  const reachable = harness.reachableTools;
  const mustStubHere = (tool: string): boolean =>
    mustStub(tool, registry, harness.unavailableTools, harness.inertTools);
  for (const c of cases) {
    for (const tool of c.explicitStubTools) {
      if (!reachable.has(tool)) {
        problems.push(`${c.name}: stubs '${tool}', which the coordinator is neither offered nor can activate in this stack`);
      }
    }
    const hasSuccessStub = (tool: string): boolean => (c.toolStubs[tool] ?? []).some(st => st.error === undefined);
    const needsStub = (tool: string): boolean =>
      reachable.has(tool) && !c.toolStubs[tool] && mustStubHere(tool);

    for (const b of c.expectedBehaviors) {
      if (!b.check) continue;
      const where = `${c.name}: behavior '${b.id}'`;
      // any_of alternatives are validated like top-level checks (#1972).
      for (const check of leafChecks(b.check)) {
        const named = check.kind === 'called' ? [check.tool]
          : check.kind === 'not_called' || check.kind === 'order' ? check.tools : [];

        // A check on a tool that does not exist can never fail (not_called) or never pass
        // (called) — either way it measures a typo.
        for (const tool of named) {
          if (!registry.get(tool)) problems.push(`${where} names '${tool}', which is not a registered tool`);
        }
        if ((check.kind === 'called' || check.kind === 'order')) {
          for (const tool of named.filter(t => registry.get(t) && !reachable.has(t))) {
            problems.push(`${where} expects '${tool}', which the coordinator is neither offered nor can activate, so it can never pass`);
          }
        }
        // Argument keys must exist on the tool, or `with`/`contains` silently never match.
        // An MCP tool's inputs are its JSON Schema properties; its manifest `inputs` is empty.
        if ((check.kind === 'called' || check.kind === 'not_called')) {
          const keys = [...Object.keys(check.with ?? {}), ...Object.keys(check.contains ?? {})];
          for (const tool of named) {
            const registered = registry.get(tool);
            const inputs = registered?.mcpInputSchema
              ? registered.mcpInputSchema.properties ?? {}
              : registered?.manifest.inputs;
            if (!inputs) continue;
            for (const key of keys.filter(k => !Object.hasOwn(inputs, k))) {
              problems.push(`${where}: '${key}' is not an input of ${tool} (inputs: ${Object.keys(inputs).join(', ')})`);
            }
          }
        }
        if (check.kind === 'called' && needsStub(check.tool)) {
          problems.push(`${where} expects ${check.tool}, which has no stub and would be refused`);
        }
        // A forbidden tool must be stubbed to SUCCEED: the wrong path has to be available,
        // or the case tests a refusal rather than the model's choice — and a refusal there
        // would also trip the coverage gate, blaming the harness for the model's mistake.
        if (check.kind === 'not_called') {
          for (const tool of check.tools) {
            if (reachable.has(tool) && mustStubHere(tool) && !hasSuccessStub(tool)) {
              problems.push(`${where} forbids ${tool}; give it a succeeding stub so the wrong path is available`);
            }
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Rate every run. Each run's judge spend is added to its `usage` (so the runs are
 * returned too, with that filled in).
 */
async function rateRuns(
  scenario: ScenarioCase,
  runs: ScenarioRun[],
  harness: ScenarioHarness,
  judge: Judge,
): Promise<{ ratings: Map<string, RunRating[]>; runs: ScenarioRun[] }> {
  const ratings = new Map<string, RunRating[]>(scenario.expectedBehaviors.map(b => [b.id, []]));
  const rated: ScenarioRun[] = [];

  for (const run of runs) {
    if (run.error) {
      // A run that never finished demonstrates nothing; every behavior misses. Checked
      // before placeholder resolution: a run whose seed failed has no refs to resolve.
      for (const b of scenario.expectedBehaviors) {
        ratings.get(b.id)!.push({ rating: 'MISS', justification: `run errored: ${run.error}` });
      }
      rated.push(run);
      continue;
    }
    // Each run seeded its own rows, so {{entry:x}} in a check means this run's id, and
    // resolved its dates against its own clock, so {{day:…}} means that run's day.
    const behaviors = resolveRunPlaceholders(scenario.expectedBehaviors, run);
    const judged = behaviors.filter(b => !b.check);
    const judgeUsage = new UsageLedger();
    const judgeScores = await judgeRun(scenario, run, judged, judge, judgeUsage);
    rated.push({ ...run, usage: sumBreakdowns([run.usage, judgeUsage.snapshot()]) });
    for (const b of behaviors) {
      ratings.get(b.id)!.push(
        b.check
          ? evaluateCheck(b.check, run, { internalNames: harness.internalNames })
          : judgeScores.get(b.id)!,
      );
    }
  }
  return { ratings, runs: rated };
}

/**
 * The commit under test, with `-dirty` when tracked files have uncommitted changes: the
 * release pre-flight compares this to the security gate's SHA, and a clean SHA over edited
 * code would claim a result for code that never ran.
 */
function gitCommit(): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf-8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: import.meta.dirname, encoding: 'utf-8' });
    return status.trim() === '' ? sha : `${sha}-dirty`;
  } catch {
    // Not fatal — results are still useful without it — but say so: the release gate
    // records this SHA, and a silent blank would look like it was never captured.
    err('  [WARN] could not read the git commit (git rev-parse failed)');
    return undefined;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  // At start, not at the end: the results must name the code that ran, and HEAD can move
  // during a half-hour suite.
  const commit = gitCommit();
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
  out(`   Concurrency: ${args.concurrency} case(s) at a time (--concurrency)`);
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
  const stopHooks: Array<() => Promise<void>> = [];
  try {
    const principal = harness.stack.principalContactId
      ? await harness.stack.contactService.getContact(harness.stack.principalContactId)
      : undefined;
    const judge = createJudge(harness.stack.llmProviders, principal?.displayName, { logger: harness.stack.logger });
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

    const releaseLock = await acquireSuiteLock(harness.stack);
    if (!releaseLock) {
      err('\nAnother `pnpm scenarios` is already running against this database. Two suites would');
      err('delete each other\'s fixtures; wait for it to finish.');
      exitCode = 1;
      return;
    }
    stopHooks.push(releaseLock);

    // A crashed or interrupted earlier run may have left fixtures a real instance would
    // act on. Found only by the suite's own markers.
    const swept = await harness.sweep();
    if (Object.keys(swept).length > 0) {
      out(`   Removed leftovers from an interrupted run: ${Object.entries(swept).map(([t, n]) => `${t} ×${n}`).join(', ')}`);
    }

    // Ctrl-C mid-run would skip the run's cleanup. Sweep on the way out instead.
    const onSignal = (signal: NodeJS.Signals): void => {
      err(`\n${signal}: cleaning up scenario fixtures before exiting...`);
      void harness.sweep()
        .catch((e: unknown) => err(`  [WARN] cleanup on ${signal} failed: ${e instanceof Error ? e.message : String(e)} — re-run to sweep leftovers`))
        .finally(() => process.exit(130));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const problems = staticProblems(cases, harness);
    if (problems.length > 0) {
      err('\nCase problems (fix before a paid run):');
      for (const p of problems) err(`   ${p}`);
      exitCode = 1;
      return;
    }

    out('\n-- Running --\n');
    // Set when a client connects mid-suite, or a case fails in a way that would repeat (a
    // judge auth error): cases not yet started are skipped, and running ones stop at
    // their next run instead of paying for runs nobody will see scored.
    let stopReason: string | undefined;
    const keysOf = new Map(cases.map(c => [c, seedConflictKeys(c)]));
    const caseResults = await runConcurrently(cases, args.concurrency, async (scenario): Promise<CaseResult | undefined> => {
      if (stopReason) return undefined;
      // An idle instance can hold no connection for most of a scheduler cycle, so one
      // check at start-up is not enough: look again before every case.
      if (!args.allowOtherConnections) {
        const late = await otherDatabaseClients(harness.stack);
        if (late.length > 0) {
          stopReason ??= `Another client connected mid-suite (${late.map(o => `${o.application} ×${o.count}`).join(', ')}); stopping.`;
          return undefined;
        }
      }
      const n = args.runs ?? scenario.runs ?? DEFAULT_RUNS;
      const runs: ScenarioRun[] = [];
      // A case's runs stay one at a time: each seeds the same contacts (seed.ts).
      for (let i = 0; i < n; i++) {
        if (stopReason) return undefined;
        const run = await harness.runOnce(scenario, i, {
          onProviderRetry: (reason) => out(`   ${scenario.name} [${i + 1}/${n}] provider failure: ${reason} — running it again (not counted)`),
        });
        runs.push(run);
        // `name!` = refused by the stub layer (a hole in the stub table);
        // `name~` = an unstubbed snapshot MCP tool answered with a stand-in (also a hole);
        // `name?` = a real read-only tool that failed (e.g. no mail client in test mode).
        const calls = run.toolCalls.map(c =>
          c.disposition === 'refused' ? `${c.name}!`
            : c.disposition === 'canned' ? `${c.name}~`
              : c.disposition === 'passthrough' && c.result?.success === false ? `${c.name}?`
                : c.name).join(', ') || 'no tools';
        out(`   ${scenario.name} [${i + 1}/${n}] ${run.error ? `ERROR ${run.error}` : `${Math.round(run.durationMs / 1000)}s — ${calls}`}`);
      }
      let rated: Awaited<ReturnType<typeof rateRuns>>;
      try {
        rated = await rateRuns(scenario, runs, harness, judge);
      } catch (e) {
        stopReason ??= `Rating '${scenario.name}' failed: ${describeError(e)}`;
        throw e;
      }
      const result = scoreCase(scenario.name, scenario.expectedBehaviors, rated.runs, rated.ratings, scenario.knownFailure);
      // One block per case, printed at once, so concurrent cases do not interleave inside it.
      const lines = [`   == ${scenario.name}: ${formatUsd(result.usage.total.estimatedCostUsd)}`];
      for (const b of result.behaviors) {
        const flag = result.criticalFailures.includes(b.behavior.id)
          ? (result.knownFailure ? 'KNWN' : 'FAIL')
          : b.passRate >= CRITICAL_PASS_THRESHOLD ? 'ok  ' : 'low ';
        lines.push(`      ${flag} ${formatPct(b.passRate).padStart(4)}  ${b.behavior.id} [${b.behavior.weight}]`);
        if (b.passRate < 1) {
          const firstMiss = b.ratings.find(r => r.rating !== 'PASS');
          if (firstMiss) lines.push(`             e.g. ${firstMiss.justification.slice(0, 220)}`);
        }
      }
      out(lines.join('\n'));
      return result;
    }, (scenario, running) => {
      const keys = keysOf.get(scenario)!;
      return !running.some(other => keysOf.get(other)!.some(k => keys.includes(k)));
    });
    if (stopReason) {
      err(`\n${stopReason}`);
      exitCode = 1;
      return;
    }
    const results = caseResults.filter((r): r is CaseResult => r !== undefined);

    if (harness.stubs.staleCalls > 0) {
      out(`\n   [WARN] ${harness.stubs.staleCalls} tool call(s) from timed-out turns were refused (they outlived their run).`);
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

    const filtered = args.caseFilter || args.tags || args.runs !== undefined
      ? {
          ...(args.caseFilter ? { caseFilter: args.caseFilter } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.runs !== undefined ? { runs: args.runs } : {}),
        }
      : undefined;
    const known = knownFailureLines(results);
    const warnings = staleKnownFailures(results);
    const overheadUsage = harness.unattributedUsage();
    const suite: SuiteResult = {
      timestamp: new Date(started).toISOString(),
      model,
      commit,
      runsPerCase: Object.fromEntries(results.map(r => [r.name, r.runs.length])),
      cases: results,
      passed: failures.length === 0,
      ...(filtered ? { filtered } : {}),
      knownFailures: known,
      warnings,
      gateFailures: failures,
      durationMs: Date.now() - started,
      concurrency: args.concurrency,
      usage: sumBreakdowns([...results.map(r => r.usage), overheadUsage]),
      overheadUsage,
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    const resultsFile = path.join(RESULTS_DIR, `${suite.timestamp.replace(/[:.]/g, '-')}.json`);
    writeFileSync(resultsFile, JSON.stringify(suite, null, 2));

    out('\n-- Summary --\n');
    for (const r of results) {
      const status = r.criticalFailures.length === 0 ? 'PASS' : r.knownFailure ? 'KNWN' : 'FAIL';
      const retried = r.runs.reduce((n, run) => n + run.providerRetries.length, 0);
      out(
        `   ${status} ${formatPct(r.weightedScore).padStart(4)}  ${formatUsd(r.usage.total.estimatedCostUsd).padStart(7)}  ${r.name}` +
        `${r.knownFailure ? `  (known failure ${r.knownFailure.issue})` : ''}` +
        `${retried > 0 ? `  (${retried} provider retr${retried === 1 ? 'y' : 'ies'})` : ''}`,
      );
    }
    out(`\n   Commit:  ${suite.commit ?? '(unknown)'}`);
    out(`   Model:   ${model}`);
    out(`   Results: ${resultsFile}`);
    out(`   Time:    ${Math.round(suite.durationMs / 1000)}s (concurrency ${args.concurrency})`);
    out('\n   Model spend (estimated from registry prices; tests/shared/usage.ts):');
    for (const line of formatUsageLines(suite.usage)) out(`     ${line}`);
    if (overheadUsage.total.calls > 0) {
      out(`     (includes ${formatUsd(overheadUsage.total.estimatedCostUsd)} over ${overheadUsage.total.calls} call(s) made outside a run or after it ended)`);
    }
    const providerRetries = results.flatMap(r => r.runs.flatMap(run => run.providerRetries.map(reason => `${r.name} run ${run.runIndex + 1}: ${reason}`)));
    if (providerRetries.length > 0) {
      out('\n   Provider failures, re-run without counting against the case:');
      for (const line of providerRetries) out(`   - ${line}`);
    }
    if (known.length > 0) {
      out('\n   Known failures (reported, not gated):');
      for (const k of known) out(`   - ${k}`);
    }
    for (const w of warnings) out(`\n   [WARN] ${w}`);
    if (failures.length > 0) {
      out('\n   GATE FAILED:');
      for (const f of failures) out(`   - ${f}`);
      exitCode = 1;
    } else if (filtered) {
      // Exit 0, but say plainly that a narrowed run is not the release gate.
      out(`\n   Passed — but this run was filtered (${JSON.stringify(filtered)}), so it is NOT a release-gate result.`);
    } else {
      out('\n   Gate passed.');
    }
  } catch (e) {
    // Without this, the process.exit in finally would swallow the error and exit 0 —
    // a crashed gate reporting success. describeError lists an AggregateError's inner
    // errors, which its stack omits.
    err(`\nFatal: ${describeError(e)}${e instanceof Error && e.stack ? `\n${e.stack}` : ''}`);
    exitCode = 1;
  } finally {
    for (const stop of stopHooks) {
      try {
        await stop();
      } catch (e) {
        err(`  [WARN] ${e instanceof Error ? e.message : String(e)}`);
      }
    }
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
