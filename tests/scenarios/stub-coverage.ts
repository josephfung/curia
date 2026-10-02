// tests/scenarios/stub-coverage.ts — a committed record of how many calls each case made
// that the stub layer refused (ported from curia-deploy tests/eval/stub-coverage.ts).
//
// A refused call reaches the model as a tool failure, so whatever it does next is the
// harness's doing, scored against the model — and unevenly: a model that explores more
// tool paths hits more holes. The CLI fails a run whose case exceeds its allowance, and
// writes the measurement here so the hole is visible in review.
//
// Why committed rather than read from results/: results/ is gitignored, so a gate that
// read the newest results file would pass vacuously on a clean clone.
//
// Difference from curia-deploy: an entry records the worst run of the latest
// measurement, not the worst ever. Their file folds across a multi-model sweep; here one
// invocation runs one model, and a fixed stub table should clear on the next run rather
// than needing a hand edit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface CoverageEntry {
  /** Max refused calls across the recorded runs. null means not yet measured. */
  unstubbed: number | null;
  runs?: number;
  model?: string;
  recordedAt?: string;
  /** Required when `unstubbed` is null: why it has not been measured. */
  reason?: string;
  /** A documented, reviewable exception. */
  allowUnstubbed?: { count: number; reason: string };
}

export interface CoverageFile {
  _note?: string;
  cases: Record<string, CoverageEntry>;
}

const NOTE =
  'Written by tests/scenarios/cli.ts after each case. unstubbed is the MAX over that measurement\'s runs: ' +
  'the worst run is the one that reveals a hole in the stub table. Checked by tests/unit/scenarios/cases.test.ts.';

export function readCoverage(file: string): CoverageFile {
  if (!existsSync(file)) return { cases: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${(err as Error).message}. ` +
      'Fix or delete it — a corrupt coverage file must not silently disable the gate.',
    );
  }
  const cases = (parsed as CoverageFile | null)?.cases;
  if (typeof cases !== 'object' || cases === null || Array.isArray(cases)) {
    throw new Error(`${file}: 'cases' must be an object keyed by case name`);
  }
  return { _note: (parsed as CoverageFile)._note, cases };
}

export interface CoverageUpdate {
  name: string;
  model: string;
  runs: Array<{ unstubbedCalls: number }>;
}

export function mergeCoverage(existing: CoverageFile, updates: CoverageUpdate[]): CoverageFile {
  // Only cases this invocation ran are replaced, so `--case` iteration on one case
  // cannot blank the record for the rest.
  const cases = { ...existing.cases };
  for (const u of updates) {
    const prior = cases[u.name];
    cases[u.name] = {
      // An allowance is a reviewed human decision, so it survives re-measurement. A
      // `reason` explains an unmeasured entry and is dropped once there is data.
      ...(prior?.allowUnstubbed ? { allowUnstubbed: prior.allowUnstubbed } : {}),
      unstubbed: Math.max(0, ...u.runs.map(r => r.unstubbedCalls)),
      runs: u.runs.length,
      model: u.model,
      recordedAt: new Date().toISOString(),
    };
  }
  // Stable key order keeps the committed diff readable.
  const sorted = Object.fromEntries(Object.entries(cases).sort(([a], [b]) => a.localeCompare(b)));
  return { _note: NOTE, cases: sorted };
}

export function writeCoverage(file: string, coverage: CoverageFile): void {
  writeFileSync(file, JSON.stringify({ _note: NOTE, cases: coverage.cases }, null, 2) + '\n');
}

/**
 * The gate. One line per violation; empty means pass. `strict` also fails entries that
 * were never measured — off for CI (a case can land before a paid run exists), on for
 * the release gate.
 */
export function coverageViolations(caseNames: string[], coverage: CoverageFile, options: { strict: boolean }): string[] {
  const violations: string[] = [];
  for (const name of caseNames) {
    const entry = coverage.cases[name];
    if (!entry) {
      violations.push(
        `${name}: no entry in stub-coverage.json. Run the case and let the CLI record it, or add ` +
        `"unstubbed": null with a reason.`,
      );
      continue;
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      violations.push(`${name}: coverage entry must be an object with an "unstubbed" field`);
      continue;
    }
    if (entry.allowUnstubbed && !entry.allowUnstubbed.reason?.trim()) {
      violations.push(`${name}: allowUnstubbed needs a non-empty reason — an undocumented allowance is indistinguishable from silencing the gate`);
      continue;
    }
    // `{}` or `{"unstubbed": "abc"}` must not pass: that is the shape a hand-edit to
    // quiet a noisy case produces.
    const measured = entry.unstubbed;
    if (!(measured === null || (typeof measured === 'number' && Number.isInteger(measured) && measured >= 0))) {
      violations.push(`${name}: "unstubbed" must be null or a non-negative integer (got ${JSON.stringify(measured)})`);
      continue;
    }
    if (measured === null) {
      if (!entry.reason?.trim()) violations.push(`${name}: "unstubbed": null needs a reason saying why it is unmeasured`);
      else if (options.strict) violations.push(`${name}: unverified stub coverage (${entry.reason})`);
      continue;
    }
    const allowed = entry.allowUnstubbed?.count ?? 0;
    if (measured > allowed) {
      violations.push(
        `${name}: ${measured} refused tool call(s) in its worst run (allowed: ${allowed}). ` +
        'The case is partly measuring the harness rather than the model — stub the call or document an allowance.',
      );
    }
  }
  return violations;
}
