// tests/smoke/cli.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { loadTestCases } from './loader.js';
import { createHarness } from './harness.js';
import { runTestCases } from './runner.js';
import { evaluateCases } from './evaluator.js';
import { generateReport } from './report.js';
import type { RunResult, HistoricalEntry } from './types.js';

const CASES_DIR = path.resolve(import.meta.dirname, 'cases');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');
const REPORTS_DIR = path.resolve(import.meta.dirname, 'reports');

async function main(): Promise<void> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  // Parse CLI args
  const args = process.argv.slice(2);
  const tags = parseArg(args, '--tags')?.split(',');
  const caseFilter = parseArg(args, '--case');

  // Validate OPENAI_API_KEY for judge
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    process.stderr.write('Error: OPENAI_API_KEY is required for the judge model\n');
    process.exit(1);
  }

  // Load test cases
  let cases = loadTestCases(CASES_DIR, tags ? { tags } : undefined);
  if (caseFilter) {
    cases = cases.filter(c => c.name.toLowerCase().includes(caseFilter.toLowerCase()));
  }

  if (cases.length === 0) {
    process.stderr.write('No test cases found matching the filters\n');
    process.exit(1);
  }

  process.stdout.write(`\nCuria Smoke Test\n`);
  process.stdout.write(`   ${cases.length} test cases loaded\n\n`);

  // Boot harness
  process.stdout.write('   Booting Curia stack...\n');
  let harness;
  try {
    harness = await createHarness();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nFailed to boot Curia stack: ${detail}\n`);
    process.stderr.write('Check that DATABASE_URL and ANTHROPIC_API_KEY are set and the database is reachable.\n');
    process.exit(1);
  }
  process.stdout.write('   Stack ready.\n\n');

  // Run test cases
  process.stdout.write('-- Running Test Cases --\n\n');
  const executions = await runTestCases(harness, cases, {
    onCaseComplete: (exec, index, total) => {
      const status = exec.error
        ? 'ERROR'
        : `${exec.responses.reduce((sum, r) => sum + r.durationMs, 0)}ms`;
      process.stdout.write(`   [${index}/${total}] ${exec.testCase.name}... ${status}\n`);
    },
  });

  // Shut down harness (we don't need it for evaluation)
  try {
    await harness.shutdown();
  } catch (err) {
    process.stderr.write(`  [WARN] Harness shutdown error: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Evaluate with judge
  process.stdout.write('\n-- Evaluating Responses --\n\n');
  const caseResults = await evaluateCases(executions, openaiKey, {
    onCaseEval: (name, i, total) => {
      process.stdout.write(`   [${i}/${total}] Judging: ${name}...\n`);
    },
  });

  // Compute overall score
  const overallScore = caseResults.length > 0
    ? caseResults.reduce((sum, c) => sum + c.weightedScore, 0) / caseResults.length
    : 0;

  const runResult: RunResult = {
    timestamp,
    cases: caseResults,
    overallScore,
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
  } catch (err) {
    process.stderr.write(`  [WARN] Failed to write results: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Generate HTML report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const html = generateReport(runResult, history);
  const reportFile = path.join(REPORTS_DIR, `${fileTimestamp(timestamp)}.html`);
  try {
    writeFileSync(reportFile, html);
  } catch (err) {
    process.stderr.write(`  [WARN] Failed to write report: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Summary
  process.stdout.write('\n-- Summary --\n\n');
  process.stdout.write(`   Overall Score: ${Math.round(overallScore * 100)}%\n`);
  process.stdout.write(`   Duration:      ${Math.round(runResult.durationMs / 1000)}s\n`);
  process.stdout.write(`   Results:       ${resultsFile}\n`);
  process.stdout.write(`   Report:        ${reportFile}\n\n`);

  // Per-case summary
  for (const c of caseResults) {
    const pct = Math.round(c.weightedScore * 100);
    const indicator = pct >= 80 ? 'PASS' : pct >= 40 ? 'PARTIAL' : 'FAIL';
    process.stdout.write(`   [${indicator}] ${pct.toString().padStart(3)}%  ${c.testCase.name}\n`);
  }
  process.stdout.write('\n');
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
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  [WARN] Skipping corrupt results file ${f}: ${detail}\n`);
        return null;
      }
    })
    .filter((e): e is HistoricalEntry => e !== null);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
