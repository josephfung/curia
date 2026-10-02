// tests/smoke/cli.ts
//
// `pnpm smoke [--model <id>] [--case <substring>] [--tags a,b]`
//
// Exits 1 when any case fails the gate (gate.ts: weighted score below 80%, a critical
// behavior rated MISS, an execution or judge error, or a failed cleanup). The release
// pre-flight in CLAUDE.md runs it on the production standard-tier model.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { createJudge } from '../scenarios/judge.js';
import { loadTestCases } from './loader.js';
import { createHarness, RESPONSE_TIMEOUT_MS, type CuriaHarness } from './harness.js';
import { runTestCases } from './runner.js';
import { evaluateCases } from './evaluator.js';
import { formatPct } from './gate.js';
import { generateReport } from './report.js';
import { CASE_PASS_THRESHOLD, type RunResult, type HistoricalEntry } from './types.js';

const CASES_DIR = path.resolve(import.meta.dirname, 'cases');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');
const REPORTS_DIR = path.resolve(import.meta.dirname, 'reports');

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf-8' }).trim();
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

  // Parse CLI args
  const args = process.argv.slice(2);
  const tags = parseArg(args, '--tags')?.split(',');
  const caseFilter = parseArg(args, '--case');
  // Route every agent to one model (e.g. the production standard-tier model).
  // The provider follows from the model registry, so this also picks Anthropic
  // vs OpenRouter. Omitted → the configured model_routing.
  const model = parseArg(args, '--model');

  // Load test cases
  let cases = loadTestCases(CASES_DIR, tags ? { tags } : undefined);
  if (caseFilter) {
    cases = cases.filter(c => c.name.toLowerCase().includes(caseFilter.toLowerCase()));
  }
  const filtered = Boolean(tags || caseFilter);

  if (cases.length === 0) {
    err('No test cases found matching the filters');
    process.exit(1);
  }

  const timeoutSec = Math.round(RESPONSE_TIMEOUT_MS / 1000);
  out(`\nCuria Smoke Test`);
  out(`   ${cases.length} test cases loaded`);
  out(`   Response timeout: ${timeoutSec}s (override with SMOKE_TIMEOUT_MS)`);
  out(`   Gate: every case ≥ ${formatPct(CASE_PASS_THRESHOLD)} weighted, no critical behavior MISS\n`);

  // Boot harness
  out('   Booting Curia stack...');
  let harness: CuriaHarness;
  try {
    harness = await createHarness({ model });
  } catch (e) {
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
    const judge = createJudge(harness.stack.llmProviders, principal?.displayName);
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
        `   Coordinator tools disabled in test mode (${coordinatorDisabled.length}): ` +
        `${coordinatorDisabled.map(d => d.tool).join(', ')}`,
      );
    }

    // An interrupted earlier run may have left conversation rows that would leak into
    // later principal turns. Found only by smoke's own conversation-id prefixes.
    const swept = await harness.sweep();
    const sweptRows = Object.entries(swept).filter(([, n]) => n > 0);
    if (sweptRows.length > 0) {
      out(`   Removed leftovers from an earlier run: ${sweptRows.map(([t, n]) => `${t} ×${n}`).join(', ')}`);
    }
    // Ctrl-C mid-case would skip the case's cleanup. Sweep on the way out instead.
    const onSignal = (signal: NodeJS.Signals): void => {
      err(`\n${signal}: removing smoke conversation rows before exiting...`);
      void harness.sweep()
        .catch((e: unknown) => err(`  [WARN] cleanup on ${signal} failed: ${e instanceof Error ? e.message : String(e)} — re-run to sweep leftovers`))
        .finally(() => process.exit(130));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    out('');

    // Run test cases
    out('-- Running Test Cases --\n');
    const executions = await runTestCases(harness, cases, {
      onWarmUp: () => {
        out('   Warming up stack...');
      },
      onCaseComplete: (exec, index, total) => {
        const status = exec.error
          ? `ERROR (${exec.error})`
          : exec.responses.map(r => `${r.durationMs}ms`).join(' + ');
        out(`   [${index}/${total}] ${exec.testCase.name}... ${status}`);
      },
    });

    // Evaluate with judge (before shutdown: the judge uses the stack's provider)
    out('\n-- Evaluating Responses --\n');
    const caseResults = await evaluateCases(executions, judge, {
      onCaseEval: (name, i, total) => {
        out(`   [${i}/${total}] Judging: ${name}...`);
      },
    });

    // Compute overall score
    const overallScore = caseResults.length > 0
      ? caseResults.reduce((sum, c) => sum + c.weightedScore, 0) / caseResults.length
      : 0;
    const failing = caseResults.filter(c => !c.passed);

    const runResult: RunResult = {
      timestamp,
      model: modelLabel,
      commit,
      filtered,
      cases: caseResults,
      overallScore,
      passed: failing.length === 0,
      durationMs: Date.now() - startTime,
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
    out(`   Passed:        ${caseResults.length - failing.length}/${caseResults.length} cases`);
    out(`   Duration:      ${Math.round(runResult.durationMs / 1000)}s`);
    out(`   Commit:        ${commit}`);
    out(`   Results:       ${resultsFile}`);
    out(`   Report:        ${reportFile}\n`);

    // Per-case summary
    for (const c of caseResults) {
      out(`   [${c.passed ? 'PASS' : 'FAIL'}] ${formatPct(c.weightedScore).padStart(4)}  ${c.testCase.name}`);
      for (const f of c.failures) out(`            ${f}`);
    }
    out('');

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
    try {
      await harness.shutdown();
    } catch (e) {
      err(`  [WARN] Harness shutdown error: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(exitCode);
  }
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
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
