// Layer-2 A/C cases must set `success` on every `called` check (#2764 §10 / Layer 1).
// A plain `called: tool` counts a runtime refusal as a hit; `success: true` does not.
//
// Exempt:
// - upper-bound budgets with an explicit `min: 0` — refused calls still cost a call
//   (`max` alone defaults min to 1 in assertions.ts, so that is a positive check)
// - named "tries X" / budget leaves whose stubs fail on purpose (48l / 30i / 23)
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leafChecks } from '../../scenarios/assertions.js';
import { loadScenarioCases } from '../../scenarios/loader.js';
import type { BehaviorCheck } from '../../scenarios/types.js';

const CASES_DIR = path.resolve(import.meta.dirname, '../../scenarios/cases');

/** Basename prefixes for design §10 A (activation-needed) + C (specialists) + D (new). */
const LAYER2_CALLED_SUCCESS_PREFIXES = [
  // A
  '05a-', '05b-', '06-', '06b-', '13a-', '13b-', '13c-', '13d-', '13f-',
  '14a-', '14b-', '14d-', '14e-', '15b-', '15c-', '15d-', '17a-', '17b-',
  '18-', '20-', '22-', '23-', '24a-', '24b-', '25k-', '25m-', '25n-', '26-',
  '32f-', '34c-', '34k-', '34l-', '34n-', '34o-', '36a-', '40c-', '40f-', '40g-',
  '42a-', '46g-', '48b-', '48d-', '48f-', '48g-', '48h-', '48i-', '48j-', '48l-',
  '54a-',
  // C
  '30a-', '30i-', '30z-', '30af-', '30ag-',
  '31a-', '31b-', '31c-', '31d-', '31m-',
  '32b-', '32c-', '32d-',
  '33a-', '33b-', '33c-', '33d-', '33e-', '33f-', '33g-', '33h-', '33i-', '33j-', '33k-',
  // D
  '60a-', '60b-', '60c-', '60d-', '60e-', '60f-', '60g-',
] as const;

/** Behaviors whose stubs fail on purpose — the check is the attempt, not success. */
const TRY_FAILURE_EXEMPT = new Set([
  '48l-deep-dive-workspace-failure-falls-back.yaml :: tries_a_document',
  '30i-inbox-reification-no-unbacked-promise.yaml :: tried_backing_task',
  // Upper-bound budget without an explicit min:0 (assertions default min→1).
  '23-no-tool-booking-takes-a-route.yaml :: bounded_venue_lookup',
]);

function isUpperBoundBudget(leaf: Extract<BehaviorCheck, { kind: 'called' }>): boolean {
  return leaf.max !== undefined && leaf.min === 0;
}

describe('Layer-2 called checks require success (#2764)', () => {
  const cases = loadScenarioCases(CASES_DIR).filter((c) => {
    const base = path.basename(c.sourceFile);
    return LAYER2_CALLED_SUCCESS_PREFIXES.some((p) => base.startsWith(p));
  });

  it('covers the targeted A/C/D basename set', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it('every called leaf sets success (true or false), except upper-bound / try-failure leaves', () => {
    const missing: string[] = [];
    for (const c of cases) {
      const base = path.basename(c.sourceFile);
      for (const b of c.expectedBehaviors) {
        if (!b.check) continue;
        for (const leaf of leafChecks(b.check)) {
          if (leaf.kind !== 'called') continue;
          if (leaf.success !== undefined) continue;
          if (isUpperBoundBudget(leaf)) continue;
          if (TRY_FAILURE_EXEMPT.has(`${base} :: ${b.id}`)) continue;
          missing.push(`${base} :: ${b.id}`);
        }
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
