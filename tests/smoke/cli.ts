// tests/smoke/cli.ts
//
// `pnpm smoke [--model <id>] [--case <substring>]... [--tags a,b] [--concurrency N] [--show-calls] [--allow-remote-db]`
//
// Exits 1 when any case fails the gate (gate.ts: weighted score below 80%, a critical
// behavior rated MISS, or an execution or judge error), known failures aside. The
// release pre-flight in CLAUDE.md runs it on the production standard-tier model.
//
// The run happens on a throwaway copy of DATABASE_URL's database (clone-db.ts),
// dropped afterwards, so nothing the agents write reaches the real one.
//
// Cases run --concurrency at a time (default 4) and the summary prints what the run
// spent on model calls, by agent and judge (#1980).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { createJudge } from '../scenarios/judge.js';
import { parseSmokeArgs, type SmokeArgs } from './args.js';
import { stubProblems } from './stub-check.js';
import { cloneDatabase, databaseName, isLocalDatabase, type DatabaseClone } from './clone-db.js';
import { loadPeople, seedPeople } from './fixtures.js';
import { loadDefaultStubs, loadTestCases, targetProblems } from './loader.js';
import { createHarness, RESPONSE_TIMEOUT_MS, type CuriaHarness } from './harness.js';
import { runTestCases } from './runner.js';
import { evaluateCases } from './evaluator.js';
import { formatPct, gatingFailures, mergeRetries, staleKnownFailures } from './gate.js';
import { generateReport } from './report.js';
import { emptyBreakdown, formatUsageLines, formatUsd, sumBreakdowns } from '../shared/usage.js';
import { CASE_PASS_THRESHOLD, type CaseExecution, type RunResult, type HistoricalEntry } from './types.js';

const CASES_DIR = path.resolve(import.meta.dirname, 'cases');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');
const REPORTS_DIR = path.resolve(import.meta.dirname, 'reports');
/** The fixture office every case runs in: calendar, mailbox, tasks (stubs) and people (contacts). */
const OFFICE_STUBS = path.resolve(import.meta.dirname, 'stubs', 'office.yaml');
const OFFICE_PEOPLE = path.resolve(import.meta.dirname, 'fixtures', 'people.yaml');

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

/**
 * The commit the run is testing, with `-dirty` when tracked files have uncommitted changes:
 * the release pre-flight compares this to the security gate's SHA, and a clean SHA over
 * edited code would claim a result for code that never ran.
 */
function gitCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf-8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: import.meta.dirname, encoding: 'utf-8' });
    return status.trim() === '' ? sha : `${sha}-dirty`;
  } catch {
    // Not fatal — results are still useful without it — but say so: the release gate
    // records this SHA, and a silent blank would look like it was never captured.
    err('  [WARN] could not read the git commit (git rev-parse failed)');
    return '(unknown)';
  }
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  // At start, not at the end: the results must name the code that ran, and HEAD can
  // move during a long run.
  const commit = gitCommit();

  // Parse CLI args strictly (args.ts): a typo must not silently change what is measured.
  let args: SmokeArgs;
  try {
    args = parseSmokeArgs(process.argv.slice(2));
  } catch (e) {
    err(`smoke: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const { tags, model, showCalls, concurrency } = args;
  // A case runs when its name contains any --case value.
  const caseFilters = args.cases;

  // Load test cases
  let cases = loadTestCases(CASES_DIR, tags ? { tags } : undefined);
  if (caseFilters.length > 0) {
    cases = cases.filter(c => caseFilters.some(f => c.name.toLowerCase().includes(f.toLowerCase())));
  }
  const filtered = Boolean(tags || caseFilters.length > 0);
  // Load (and validate) the fixture office before paying for a database copy.
  const defaultStubs = loadDefaultStubs(OFFICE_STUBS);
  const people = loadPeople(OFFICE_PEOPLE);

  if (cases.length === 0) {
    err('No test cases found matching the filters');
    process.exit(1);
  }

  const timeoutSec = Math.round(RESPONSE_TIMEOUT_MS / 1000);
  out(`\nCuria Smoke Test`);
  out(`   ${cases.length} test cases loaded`);
  out(`   Response timeout: ${timeoutSec}s (override with SMOKE_TIMEOUT_MS)`);
  out(`   Concurrency: ${concurrency} case(s) at a time (--concurrency)`);
  out(`   Gate: every case ≥ ${formatPct(CASE_PASS_THRESHOLD)} weighted, no critical behavior MISS\n`);

  // Copy the database before anything connects to it: Postgres copies a template only
  // while no one else is attached.
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) {
    err('DATABASE_URL is not set');
    process.exit(1);
  }
  if (!isLocalDatabase(sourceUrl) && !args.allowRemoteDb) {
    err(
      `DATABASE_URL points at a non-local server (${new URL(sourceUrl).hostname}). Smoke copies that database and ` +
      'sweeps old copies on its server; it is meant for a local dev database. Pass --allow-remote-db to proceed.',
    );
    process.exit(1);
  }
  let clone: DatabaseClone;
  try {
    const created = await cloneDatabase(sourceUrl);
    clone = created;
    out(`   Database: throwaway copy of '${databaseName(sourceUrl)}' (${created.name}), dropped after the run`);
    if (created.removedStale.length > 0) out(`   Dropped copies left by earlier runs: ${created.removedStale.join(', ')}`);
  } catch (e) {
    err(`\nCould not copy the database: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // Everything below — the stack, the vault, every tool — reads the copy.
  process.env.DATABASE_URL = clone.url;
  const dropClone = async (): Promise<void> => {
    try {
      await clone.drop();
    } catch (e) {
      err(`  [WARN] could not drop ${clone.name}: ${e instanceof Error ? e.message : String(e)} — the next run drops it`);
    }
  };
  // Ctrl-C, a closed terminal or a crash would skip the finally below; drop the copy (a
  // full copy of the vault) on the way out instead. Repeated signals while it drops are
  // ignored, so a second Ctrl-C does not kill the process mid-drop.
  let exiting = false;
  const dropAndExit = (why: string, code: number): void => {
    if (exiting) return;
    exiting = true;
    err(`\n${why}: dropping ${clone.name} before exiting...`);
    void dropClone().finally(() => process.exit(code));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => dropAndExit(signal, 130));
  }
  process.on('uncaughtException', (e) => {
    err(`Uncaught exception: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    dropAndExit('uncaught exception', 1);
  });
  process.on('unhandledRejection', (e) => {
    err(`Unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    dropAndExit('unhandled rejection', 1);
  });

  // Boot harness
  out('   Booting Curia stack...');
  let harness: CuriaHarness;
  try {
    harness = await createHarness({ model });
  } catch (e) {
    await dropClone();
    const detail = e instanceof Error ? e.message : String(e);
    err(`\nFailed to boot Curia stack: ${detail}`);
    // LLM keys are read from the vault only (#911) — exporting ANTHROPIC_API_KEY or
    // OPENROUTER_API_KEY does nothing, so don't send the operator there.
    err(
      'Check that DATABASE_URL is set and the database is reachable, that SECRET_ENCRYPTION_KEY is set, ' +
      'and that the vault holds the selected model\'s provider key (anthropic_api_key or openrouter_api_key) ' +
      'and openrouter_api_key for the judge. Env vars are not read for LLM keys (#911).',
    );
    process.exit(1);
  }

  let exitCode = 0;
  try {
    const modelLabel = model ?? harness.stack.yamlConfig.model_routing?.tiers.standard.model ?? null;
    const principal = harness.stack.principalContactId
      ? await harness.stack.contactService.getContact(harness.stack.principalContactId)
      : undefined;
    if (!principal) {
      // Cases name the principal ({{principal:…}}) and the judge checks "never addresses
      // the principal"; without one they would run on literal placeholders.
      throw new Error('this database has no principal contact; smoke needs an onboarded database');
    }
    const judge = createJudge(harness.stack.llmProviders, principal.displayName, { logger: harness.logger });
    out('   Stack ready.');
    out(`   Model: ${modelLabel ?? 'configured model_routing'}`);
    out(`   Judge: ${judge.model} (OpenRouter)`);
    out(`   Commit: ${commit}`);
    // Differences from production that change what the agents see or can do. The
    // stack's own logger is error-level, so print them here or nobody sees them.
    for (const warning of harness.stack.warnings) {
      out(`   [WARN] ${warning}`);
    }
    const coordinatorDisabled = harness.stack.disabledTools['coordinator'] ?? [];
    if (coordinatorDisabled.length > 0) {
      out(
        `   Coordinator tools disabled in test mode unless a case stubs them (${coordinatorDisabled.length}): ` +
        `${coordinatorDisabled.map(d => d.tool).join(', ')}`,
      );
    }
    const today = todayIn(harness.stack.config.timezone);
    out(`   Today: ${today}`);

    // A stub naming a tool or input that doesn't exist never fires; fail before a paid run.
    const problems = stubProblems(
      [
        { source: 'stubs/office.yaml', stubs: defaultStubs },
        ...cases.flatMap(c => [
          { source: c.name, stubs: c.toolStubs },
          ...c.turns.map((t, i) => ({ source: `${c.name} turn ${i + 1}`, stubs: t.toolStubs ?? {} })),
        ]),
      ],
      { inputsOf: (tool) => { const t = harness.stack.toolRegistry.get(tool); return t ? Object.keys(t.manifest.inputs ?? {}) : undefined; } },
    );
    // A target naming an agent this stack does not run would only time out.
    problems.push(...targetProblems(cases, (name) => harness.stack.agentRegistry.has(name)));
    if (problems.length > 0) {
      err('\nStub and target problems (fix before a paid run):');
      for (const p of problems) err(`   ${p}`);
      exitCode = 1;
      return;
    }
    const seeded = await seedPeople(harness.stack, people);
    out(`   Fixture office: ${seeded} people seeded; ${Object.keys(defaultStubs).length} tools stubbed by default`);
    out('');

    // Run test cases
    out('-- Running Test Cases --\n');
    const onCaseComplete = (exec: CaseExecution, index: number, total: number): void => {
      const status = exec.error
        ? `ERROR (${exec.error})`
        : exec.responses.map(r => `${r.durationMs}ms`).join(' + ');
      out(`   [${index}/${total}] ${exec.testCase.name}... ${status}  ${formatUsd(exec.usage.total.estimatedCostUsd)}`);
      if (showCalls) {
        for (const c of exec.agentCalls) {
          const outcome = c.success === undefined ? '' : c.success ? ' ok' : ' FAILED';
          out(`        ${c.agentId ?? '?'} → ${c.toolName} [${c.disposition}${outcome}] ${JSON.stringify(c.input).slice(0, 160)}`);
        }
      }
    };
    const onProviderRetry = (tc: { name: string }, reason: string): void => {
      out(`   [provider] ${tc.name}: ${reason} — running it again (not the gated retry)`);
    };
    const principalRef = { name: principal.displayName, contactId: principal.id };
    const { executions, warmUpUsage } = await runTestCases(harness, cases, {
      defaultStubs,
      principal: principalRef,
      concurrency,
      onWarmUp: () => {
        out('   Warming up stack...');
      },
      onCaseComplete,
      onProviderRetry,
    });

    // Evaluate with judge (before shutdown: the judge uses the stack's provider)
    out('\n-- Evaluating Responses --\n');
    const onCaseEval = (name: string, i: number, total: number): void => {
      out(`   [${i}/${total}] Judging: ${name}...`);
    };
    let caseResults = await evaluateCases(executions, judge, { today, onCaseEval, concurrency });

    // One retry for each gating failure (gate.ts explains why). Known failures are not
    // retried: they are expected to fail. Provider failures were already re-run above,
    // without using this retry.
    const toRetry = gatingFailures(caseResults);
    if (toRetry.length > 0) {
      out(`\n-- Retrying ${toRetry.length} failing case(s) once --\n`);
      const { executions: retryExecutions } = await runTestCases(harness, toRetry.map(c => c.testCase), {
        defaultStubs,
        principal: principalRef,
        concurrency,
        warmUp: false,
        onCaseComplete,
        onProviderRetry,
      });
      const retryResults = await evaluateCases(retryExecutions, judge, { today, onCaseEval, concurrency });
      caseResults = mergeRetries(caseResults, retryResults);
    }

    // Compute overall score
    const overallScore = caseResults.length > 0
      ? caseResults.reduce((sum, c) => sum + c.weightedScore, 0) / caseResults.length
      : 0;
    const failing = gatingFailures(caseResults);
    const knownFailing = caseResults.filter(c => !c.passed && !failing.includes(c));
    const stale = staleKnownFailures(caseResults);
    // The warm-up and anything no case made: real spend, but no case's.
    const overheadUsage = sumBreakdowns([warmUpUsage ?? emptyBreakdown(), harness.unattributedUsage()]);

    const runResult: RunResult = {
      timestamp,
      model: modelLabel,
      commit,
      filtered,
      cases: caseResults,
      overallScore,
      passed: failing.length === 0,
      durationMs: Date.now() - startTime,
      concurrency,
      today,
      usage: sumBreakdowns([...caseResults.map(c => c.usage), overheadUsage]),
      overheadUsage,
    };

    // Load historical data BEFORE writing current results, so the trend chart
    // shows only previous runs (not the current run duplicated as history).
    const history = loadHistory(RESULTS_DIR);

    // Save results JSON
    mkdirSync(RESULTS_DIR, { recursive: true });
    const resultsFile = path.join(RESULTS_DIR, `${fileTimestamp(timestamp)}.json`);
    try {
      writeFileSync(resultsFile, JSON.stringify(runResult, null, 2));
    } catch (e) {
      err(`  [WARN] Failed to write results: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Generate HTML report
    mkdirSync(REPORTS_DIR, { recursive: true });
    const html = generateReport(runResult, history);
    const reportFile = path.join(REPORTS_DIR, `${fileTimestamp(timestamp)}.html`);
    try {
      writeFileSync(reportFile, html);
    } catch (e) {
      err(`  [WARN] Failed to write report: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Summary
    out('\n-- Summary --\n');
    out(`   Overall Score: ${formatPct(overallScore)}`);
    out(`   Passed:        ${caseResults.filter(c => c.passed).length}/${caseResults.length} cases` +
      (knownFailing.length > 0 ? ` (${knownFailing.length} known failure(s))` : ''));
    out(`   Duration:      ${Math.round(runResult.durationMs / 1000)}s (concurrency ${concurrency})`);
    out(`   Commit:        ${commit}`);
    out(`   Results:       ${resultsFile}`);
    out(`   Report:        ${reportFile}\n`);
    out('   Model spend (estimated from registry prices; tests/shared/usage.ts):');
    for (const line of formatUsageLines(runResult.usage)) out(`     ${line}`);
    if (overheadUsage.total.calls > 0) {
      out(`     (includes ${formatUsd(overheadUsage.total.estimatedCostUsd)} outside any case: the warm-up${harness.unattributedUsage().total.calls > 0 ? ' and unattributed calls' : ''})`);
    }
    if (harness.stubs.orphanCalls > 0) {
      out(`   [WARN] ${harness.stubs.orphanCalls} tool call(s) ran outside any case (answered for real, not stubbed)`);
    }
    out('');

    // Per-case summary
    for (const c of caseResults) {
      const label = c.passed ? (c.firstAttempt ? 'PASS*' : 'PASS') : knownFailing.includes(c) ? 'KNOWN' : 'FAIL';
      const issue = c.testCase.knownFailure ? `  (known failure ${c.testCase.knownFailure.issue})` : '';
      out(`   [${label}] ${formatPct(c.weightedScore).padStart(4)}  ${formatUsd(c.usage.total.estimatedCostUsd).padStart(7)}  ${c.testCase.name}${issue}`);
      if (c.firstAttempt) {
        out(`            first attempt ${formatPct(c.firstAttempt.weightedScore)}: ${c.firstAttempt.failures.join('; ')}`);
      }
      for (const r of c.providerRetries) out(`            provider retry: ${r}`);
      for (const f of c.failures) out(`            ${f}`);
    }
    if (caseResults.some(c => c.passed && c.firstAttempt)) {
      out('\n   PASS* = failed once, passed on retry. Worth a look if the same case keeps needing it.');
    }
    const providerRetried = caseResults.filter(c => c.providerRetries.length > 0);
    if (providerRetried.length > 0) {
      out(`\n   ${providerRetried.length} case(s) re-run after a provider failure (stall, provider error or model fallback).`);
      out('   Those re-runs are not the gated retry; many of them point at the provider, not the model.');
    }
    out('');
    for (const c of stale) {
      out(`   [WARN] '${c.testCase.name}' passed but is marked known_failure ${c.testCase.knownFailure!.issue} — ` +
        'if that issue is fixed, remove the marker.');
    }

    if (!runResult.passed) {
      err(`GATE FAILED: ${failing.length} case(s) below the gate.`);
      exitCode = 1;
    } else if (filtered) {
      out('Gate passed for the selected cases only (--case/--tags): not a full-suite result.');
    } else {
      out('Gate passed.');
    }
  } catch (e) {
    // Without this, the process.exit in finally would swallow the error and exit 0.
    err(`Fatal error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    exitCode = 1;
  } finally {
    // Bounded: pg's pool.end() waits for every checked-out client, and a turn still running
    // past its grace period would hold one forever, leaving the copy undropped.
    try {
      const outcome = await Promise.race([
        harness.shutdown().then(() => 'done' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
      if (outcome === 'timeout') err(`  [WARN] harness shutdown did not finish in ${SHUTDOWN_TIMEOUT_MS / 1000}s; dropping the copy anyway`);
    } catch (e) {
      err(`  [WARN] Harness shutdown error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await dropClone();
    await exitAfterFlush(exitCode);
  }
}

/** How long the harness gets to shut down before the copy is force-dropped regardless. */
const SHUTDOWN_TIMEOUT_MS = 120_000;

/**
 * Exit once stdout and stderr have drained. Piped output (`pnpm smoke | tee release.log`)
 * is asynchronous on macOS, and a bare process.exit can clip the verdict lines.
 */
async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>(resolve => process.stdout.write('', () => resolve())),
    new Promise<void>(resolve => process.stderr.write('', () => resolve())),
  ]);
  process.exit(code);
}

/** e.g. "Friday, October 2, 2026 (America/Toronto)" — the date the agents were told. */
function todayIn(timezone: string): string {
  const date = new Date().toLocaleDateString('en-US', {
    timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  return `${date} (${timezone})`;
}

function fileTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

/**
 * Load historical entries from all previous result JSON files.
 */
function loadHistory(resultsDir: string): HistoricalEntry[] {
  if (!existsSync(resultsDir)) return [];

  return readdirSync(resultsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      try {
        const data = JSON.parse(readFileSync(path.join(resultsDir, f), 'utf-8')) as RunResult;
        const totalBehaviors = data.cases.reduce(
          (sum, c) => sum + c.testCase.expectedBehaviors.length, 0,
        );
        const passBehaviors = data.cases.reduce(
          (sum, c) => sum + c.scores.filter(s => s.rating === 'PASS').length, 0,
        );
        return {
          timestamp: data.timestamp,
          overallScore: data.overallScore,
          caseCount: data.cases.length,
          passRate: totalBehaviors > 0 ? passBehaviors / totalBehaviors : 0,
        };
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        err(`  [WARN] Skipping corrupt results file ${f}: ${detail}`);
        return null;
      }
    })
    .filter((e): e is HistoricalEntry => e !== null);
}

main().catch((e) => {
  err(`Fatal error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
