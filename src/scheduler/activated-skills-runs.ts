// activated-skills-runs.ts — last-N model activations on a scheduled job (#2764).
//
// completeJobRun appends each run's model-activated skills; the next fire unions
// the last three runs into preActivateSkills.learned (by: job-learned).

const KEEP_RUNS = 3;

/** Append this run's activations and keep only the last three runs. */
export function appendActivatedSkillsRun(
  previousRuns: unknown,
  activatedSkills: readonly string[],
): string[][] {
  const prev = Array.isArray(previousRuns)
    ? previousRuns.filter((run): run is unknown[] => Array.isArray(run))
    : [];
  const cleaned = activatedSkills
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (cleaned.length === 0) {
    return prev.map((run) =>
      run.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()),
    ).slice(-KEEP_RUNS);
  }
  const normalizedPrev = prev.map((run) =>
    run.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()),
  );
  return [...normalizedPrev, cleaned].slice(-KEEP_RUNS);
}

/** Union of skill names from the last kept runs, first-seen order. */
export function learnedSkillsFromRuns(activatedSkillsRuns: unknown): string[] {
  if (!Array.isArray(activatedSkillsRuns)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const run of activatedSkillsRuns.slice(-KEEP_RUNS)) {
    if (!Array.isArray(run)) continue;
    for (const entry of run) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
