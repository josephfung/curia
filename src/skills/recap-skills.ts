// recap-skills.ts — derive CEO-recap-eligible skill names from manifests.
//
// Skills with action_risk >= low (min score 60) are consequential enough for
// the end-of-day activity recap. Built once from on-disk manifests so new skills
// are picked up automatically without maintaining a parallel allowlist.

import path from 'node:path';
import type { ActionRisk } from './types.js';
import { discoverSkillManifests } from './loader.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');

let cachedRecapSkills: Set<string> | null = null;

/** Minimum autonomy score for a skill to appear in the default activity recap. */
const RECAP_MIN_SCORE = AutonomyService.minScoreForActionRisk('low');

export function getRecapEligibleSkillNames(): Set<string> {
  if (cachedRecapSkills) return cachedRecapSkills;

  const names = new Set<string>();
  for (const disc of discoverSkillManifests(SKILLS_DIR)) {
    if (disc.error || !disc.manifest) continue;
    if (isRecapEligible(disc.manifest.action_risk)) {
      names.add(disc.manifest.name);
    }
  }
  cachedRecapSkills = names;
  return names;
}

function isRecapEligible(risk: ActionRisk): boolean {
  return AutonomyService.minScoreForActionRisk(risk) >= RECAP_MIN_SCORE;
}

/** Test-only: reset module cache between test files. */
export function resetRecapSkillCache(): void {
  cachedRecapSkills = null;
}
