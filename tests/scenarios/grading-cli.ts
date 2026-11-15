// tests/scenarios/grading-cli.ts — `pnpm grading`: human grades for choosing a judge (#2556 §4).
//
//   pnpm grading sample tests/scenarios/results/<run>.json [--n 25] [--seed s] [--layer voice|decision|all] [--out sheet.csv]
//   pnpm grading agree tests/scenarios/results/<run>.json graded.csv [--judge <model>]... [--out agreement.json]
//
// `sample` is free: it writes a grading sheet (CSV, blind to the judge's rating) and a short
// guide for the grader. `agree` reads the filled sheet and reports how far each judge agrees
// with it: the run's own judge (free, from its saved ratings) and each --judge candidate,
// which re-judges only the graded runs (judge calls only; no agent runs).
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { createTestModeStack } from '../../src/startup/test-mode-stack.js';
import { createJudge, judgeRun } from './judge.js';
import { loadScenarioCases, resolveRunPlaceholders } from './loader.js';
import {
  agreementWith,
  formatAgreementLine,
  gradingSheet,
  parseGrades,
  sampleGradingItems,
  type Agreement,
} from './grading.js';
import { formatUsd, UsageLedger } from '../shared/usage.js';
import type { RunRating, SuiteResult } from './types.js';

const CASES_DIR = path.resolve(import.meta.dirname, 'cases');
const out = (line = ''): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function flags(argv: string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name ? [argv[i + 1] ?? ''] : [])).filter(v => v !== '' && !v.startsWith('--'));
}

/** Positional arguments: everything that is not a flag or a flag's value. */
function positionals(argv: string[]): string[] {
  return argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
}

const resolvePath = (p: string): string => path.resolve(process.env['INIT_CWD'] ?? process.cwd(), p);

const GUIDE = `# Grading guide

Thank you for grading. Each row of the sheet is one situation an AI executive assistant
(Curia, working for an executive called Avery) handled, and one thing to judge about how it
wrote. You don't need to know anything about how Curia works.

For each row, read:

- **situation**: what happened, and what we think the right call is.
- **recipient**: who the message is for, when there is one.
- **messages**: what came in, then every message Curia wrote, each labelled with where it
  went (an email, a text, a draft left for Avery to send, a reply to the sender).
- **what_to_grade**: the one quality to judge in this row.

Then fill in **grade** with exactly one of:

- **PASS**: clearly and fully does what what_to_grade describes.
- **PARTIAL**: tries, but only partly gets it right.
- **MISS**: doesn't do it, or does the opposite.

Grade only what_to_grade, not everything about the messages. If Curia wrote nothing, or
nothing relevant, that is a MISS. Use **notes** for anything you'd write differently; short
notes are fine and very useful.

Leave a row's grade blank if you'd rather skip it.
`;

async function sample(argv: string[]): Promise<void> {
  const [file] = positionals(argv);
  if (!file) throw new Error('usage: pnpm grading sample <results.json> [--n 25] [--seed s] [--layer voice|decision|all] [--out sheet.csv]');
  const suite = JSON.parse(readFileSync(resolvePath(file), 'utf-8')) as SuiteResult;
  const n = Number(flag(argv, '--n') ?? 25);
  if (!Number.isInteger(n) || n < 1) throw new Error('--n must be a positive integer');
  const layer = (flag(argv, '--layer') ?? 'voice') as 'voice' | 'decision' | 'all';
  if (!['voice', 'decision', 'all'].includes(layer)) throw new Error('--layer must be voice, decision or all');
  const seed = flag(argv, '--seed') ?? suite.timestamp;
  const items = sampleGradingItems(suite, loadScenarioCases(CASES_DIR), { n, seed, layer });
  if (items.length === 0) throw new Error(`no judged ${layer} ratings to grade in ${file}`);
  const sheet = resolvePath(flag(argv, '--out') ?? file.replace(/\.json$/, '') + '.grading.csv');
  writeFileSync(sheet, gradingSheet(items));
  const guide = sheet.replace(/\.csv$/, '') + '.guide.md';
  writeFileSync(guide, GUIDE);
  const tasks = new Set(items.map(i => i.task));
  out(`${items.length} item(s) across ${new Set(items.map(i => i.caseName)).size} case(s) and ${tasks.size} task(s) (${[...tasks].sort().join(', ')})${items.length < n ? `; only ${items.length} were available` : ''}`);
  out(`Sheet: ${sheet}`);
  out(`Guide: ${guide}`);
  out(`Seed: ${seed} (pass --seed to rebuild the same sheet)`);
}

async function agree(argv: string[]): Promise<number> {
  const [file, gradesFile] = positionals(argv);
  if (!file || !gradesFile) throw new Error('usage: pnpm grading agree <results.json> <graded.csv> [--judge <model>]... [--out agreement.json]');
  const suite = JSON.parse(readFileSync(resolvePath(file), 'utf-8')) as SuiteResult;
  const human = parseGrades(readFileSync(resolvePath(gradesFile), 'utf-8'));
  if (human.size === 0) throw new Error(`${gradesFile} has no grades yet`);
  const byName = new Map(loadScenarioCases(CASES_DIR).map(c => [c.name, c]));

  // Where each graded rating is: its case, run and behavior in the saved results.
  type Located = { caseName: string; runIndex: number; behaviorId: string };
  const located = new Map<string, Located>();
  for (const id of human.keys()) {
    const m = /^(.*)#(\d+)#([^#]+)$/.exec(id);
    const result = m ? suite.cases.find(c => c.name === m[1]) : undefined;
    const runIndex = m ? Number(m[2]) - 1 : -1;
    if (!m || !result || !result.runs[runIndex] || !result.behaviors.some(b => b.behavior.id === m[3])) {
      throw new Error(`graded item '${id}' is not in ${file}: grade the sheet made from this results file`);
    }
    located.set(id, { caseName: m[1]!, runIndex, behaviorId: m[3]! });
  }

  // The run's own judge, from its saved ratings: free.
  const savedRatings = new Map<string, RunRating>();
  for (const [id, at] of located) {
    const b = suite.cases.find(c => c.name === at.caseName)!.behaviors.find(x => x.behavior.id === at.behaviorId)!;
    savedRatings.set(id, b.ratings[at.runIndex]!);
  }
  const savedJudges = new Set([...located.values()].map(at => suite.caseJudges?.[at.caseName] ?? suite.judge ?? '(not recorded)'));
  const results: Agreement[] = [agreementWith(`${[...savedJudges].join(' / ')} (the run's own ratings)`, human, savedRatings)];

  const candidates = flags(argv, '--judge');
  let spend = 0;
  if (candidates.length > 0) {
    // Only for the vault's OpenRouter key: the judge goes through the stack's provider (#911).
    // No agent runs here, so every tier is routed to a candidate (an OpenRouter model): the
    // configured routing could name a provider the vault has no key for, and fail the boot.
    const stack = await createTestModeStack({ model: candidates[0]! });
    try {
      const principal = stack.principalContactId ? await stack.contactService.getContact(stack.principalContactId) : undefined;
      // Every candidate first: an unpriced model fails here, before any paid call.
      const judges = candidates.map(model => createJudge(stack.llmProviders, principal?.displayName, { model, logger: stack.logger }));
      // Each graded run is judged once per candidate, on all its judged behaviors, as a live run is.
      const runs = new Map<string, Located>();
      for (const at of located.values()) runs.set(`${at.caseName}#${at.runIndex}`, at);
      for (const judge of judges) {
        const usage = new UsageLedger();
        const ratings = new Map<string, RunRating>();
        for (const at of runs.values()) {
          const scenario = byName.get(at.caseName);
          if (!scenario) throw new Error(`${at.caseName}: no such case in ${CASES_DIR} any more`);
          const result = suite.cases.find(c => c.name === at.caseName)!;
          const run = { ...result.runs[at.runIndex]!, providerRetries: result.runs[at.runIndex]!.providerRetries ?? [] };
          // The behaviors as the run saved them, which is what the sheet showed the grader.
          const behaviors = resolveRunPlaceholders(result.behaviors.map(b => b.behavior), run).filter(b => !b.check);
          const rated = await judgeRun(scenario, run, behaviors, judge, usage);
          for (const [behaviorId, rating] of rated) ratings.set(`${at.caseName}#${at.runIndex + 1}#${behaviorId}`, rating);
        }
        results.push(agreementWith(judge.model, human, ratings));
        spend += usage.snapshot().judge.estimatedCostUsd;
        out(`   ${judge.model}: judged ${runs.size} run(s), ${formatUsd(usage.snapshot().judge.estimatedCostUsd)}`);
      }
    } finally {
      await stack.shutdown();
    }
  }

  out('');
  out(`Agreement with ${human.size} human grade(s):`);
  for (const a of results) out(`   ${formatAgreementLine(a)}`);
  for (const a of results.filter(r => r.disagreements.length > 0)) {
    out('');
    out(`   Disagreements, ${a.judge}:`);
    for (const d of a.disagreements) {
      const note = human.get(d.id)?.notes;
      out(`   - ${d.id}: grader ${d.human}, judge ${d.judge}. Judge: ${d.justification}${note ? `\n     Grader's note: ${note}` : ''}`);
    }
  }
  const outFile = resolvePath(flag(argv, '--out') ?? gradesFile.replace(/\.csv$/, '') + '.agreement.json');
  writeFileSync(outFile, JSON.stringify({ results: file, grades: gradesFile, graded: human.size, agreements: results, judgeSpendUsd: spend }, null, 2));
  out('');
  if (candidates.length > 0) out(`Candidate judge spend: ${formatUsd(spend)}`);
  out(`Saved: ${outFile}`);
  return 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let code = 0;
  try {
    if (command === 'sample') await sample(rest);
    else if (command === 'agree') code = await agree(rest);
    else throw new Error("usage: pnpm grading sample|agree … (see the top of tests/scenarios/grading-cli.ts)");
  } catch (e) {
    err(`grading: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  }
  process.exit(code);
}

void main();
