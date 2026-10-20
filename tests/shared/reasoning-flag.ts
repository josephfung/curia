// tests/shared/reasoning-flag.ts — the suites' --reasoning-effort flag (ADR-048).
//
// The effort A/Bs run one arm per effort. `--reasoning-effort low` sets every tier;
// `--reasoning-effort fast=none,standard=low` sets only the tiers named, so the
// fast-tier check can vary tiers.fast alone. ModelRouter still validates each effort
// against its tier's model at boot, so an effort the model cannot take fails there.

import type { Tier } from '../../src/agents/llm/model-router.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../src/agents/llm/sampling-options.js';
import type { TierReasoningOverride } from '../../src/startup/test-mode-stack.js';

const TIERS: readonly Tier[] = ['fast', 'standard', 'powerful'];

function parseEffort(raw: string): ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) {
    throw new Error(`--reasoning-effort: '${raw}' is not one of ${REASONING_EFFORTS.join(', ')}`);
  }
  return raw as ReasoningEffort;
}

/** Parse `<effort>` (every tier) or `<tier>=<effort>[,<tier>=<effort>…]`. */
export function parseReasoningEffortFlag(raw: string): TierReasoningOverride {
  const value = raw.trim();
  if (!value.includes('=')) {
    const effort = parseEffort(value);
    return Object.fromEntries(TIERS.map((tier) => [tier, { effort }]));
  }
  const override: TierReasoningOverride = {};
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [tier, effort, extra] = part.split('=').map((p) => p.trim());
    if (extra !== undefined || !tier || !effort) {
      throw new Error(`--reasoning-effort: write '<tier>=<effort>', not '${part}'`);
    }
    if (!(TIERS as readonly string[]).includes(tier)) {
      throw new Error(`--reasoning-effort: '${tier}' is not a tier (${TIERS.join(', ')})`);
    }
    if (override[tier as Tier]) throw new Error(`--reasoning-effort: tier '${tier}' given twice`);
    override[tier as Tier] = { effort: parseEffort(effort) };
  }
  return override;
}

/** "fast=none, standard=low" for a run header, or "as configured" when nothing is set. */
export function describeReasoningOverride(override: TierReasoningOverride | undefined): string {
  const parts = TIERS.flatMap((tier) => (override?.[tier] ? [`${tier}=${override[tier]!.effort}`] : []));
  if (parts.length === 0) return 'as configured';
  return parts.length < TIERS.length ? `${parts.join(', ')} (other tiers as configured)` : parts.join(', ');
}
