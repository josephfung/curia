// tests/scenarios/rescore.ts — score saved transcripts against the current case files (#2556).
//
// `pnpm rejudge --from-cases` uses this. The default re-judge keeps the behaviors a run saved,
// so an edited case cannot shift behavior ids under a judge comparison. This mode does the
// opposite on purpose: the case's expectations were revised (an outside review of the
// finesse casebook, say), and the question is what the same transcripts score under them.
//
// It is sound only while the transcript's situation is unchanged, so a case whose setup hash
// moved (setup-hash.ts) is refused: it needs a new run. Code checks are re-evaluated as well
// as judged behaviors, since a revised case can change either.
import { evaluateCheck } from './assertions.js';
import { scoreCase } from './gate.js';
import { resolveRunPlaceholders } from './loader.js';
import { caseSetupHash } from './setup-hash.js';
import { hasDatePlaceholders } from '../shared/date-placeholders.js';
import type { CaseResult, ExpectedBehavior, RunRating, ScenarioCase, ScenarioRun } from './types.js';

/** Why a saved case cannot be re-scored against `scenario`, or undefined when it can. */
export function rescoreRefusal(saved: Pick<CaseResult, 'name' | 'setupHash' | 'runs'>, scenario: ScenarioCase): string | undefined {
  if (saved.setupHash === undefined) {
    return `${saved.name}: saved without a setup hash, so an edit to its setup cannot be ruled out; run it again`;
  }
  const now = caseSetupHash(scenario);
  if (saved.setupHash !== now) {
    return `${saved.name}: its setup changed since this run (hash ${saved.setupHash} → ${now}); run it again`;
  }
  // A run saved before runs carried a clock cannot resolve date placeholders (#1958).
  if (hasDatePlaceholders(scenario.expectedBehaviors) && saved.runs.some(r => !r.error && !r.clock)) {
    return `${saved.name}: runs saved without a clock cannot resolve the case's date placeholders; run it again`;
  }
  return undefined;
}

/** What re-scoring one case found. */
export interface Rescored {
  /** The case scored against its current behaviors. */
  result: CaseResult;
  /** Behavior ids in the current case that the saved run did not have. */
  added: string[];
  /** Behavior ids the saved run had that the current case dropped. */
  removed: string[];
  /** Ids whose description, weight, layer or check changed. */
  edited: string[];
}

export type JudgeRunFn = (scenario: ScenarioCase, run: ScenarioRun, behaviors: ExpectedBehavior[]) => Promise<Map<string, RunRating>>;

/**
 * Score `saved`'s runs against `scenario`'s current behaviors: checks in code, the rest by
 * `judge`. Callers check rescoreRefusal first. An errored run misses every behavior, as in a
 * live run.
 */
export async function rescoreCase(
  saved: CaseResult,
  scenario: ScenarioCase,
  judge: JudgeRunFn,
  internalNames: string[],
): Promise<Rescored> {
  const ratings = new Map<string, RunRating[]>(scenario.expectedBehaviors.map(b => [b.id, []]));
  for (const run of saved.runs) {
    if (run.error) {
      for (const b of scenario.expectedBehaviors) ratings.get(b.id)!.push({ rating: 'MISS', justification: `run errored: ${run.error}` });
      continue;
    }
    const behaviors = resolveRunPlaceholders(scenario.expectedBehaviors, run);
    const judged = await judge(scenario, run, behaviors.filter(b => !b.check));
    for (const b of behaviors) {
      ratings.get(b.id)!.push(b.check
        ? evaluateCheck(b.check, run, { internalNames, caseAgent: scenario.agent })
        : judged.get(b.id)!);
    }
  }
  const result: CaseResult = {
    ...scoreCase(scenario.name, scenario.expectedBehaviors, saved.runs, ratings, scenario.knownFailure),
    setupHash: saved.setupHash!,
  };
  const before = new Map(saved.behaviors.map(b => [b.behavior.id, b.behavior]));
  const now = new Map(scenario.expectedBehaviors.map(b => [b.id, b]));
  return {
    result,
    added: [...now.keys()].filter(id => !before.has(id)),
    removed: [...before.keys()].filter(id => !now.has(id)),
    edited: [...now.entries()]
      .filter(([id, b]) => before.has(id) && JSON.stringify(normalize(before.get(id)!)) !== JSON.stringify(normalize(b)))
      .map(([id]) => id),
  };
}

/** A behavior with fixed key order, for comparing a saved one with the current one. */
function normalize(b: ExpectedBehavior): unknown[] {
  return [b.id, b.description.trim(), b.weight, b.layer ?? null, b.check ?? null];
}
