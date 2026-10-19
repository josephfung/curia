// sample-pool.ts — which autonomous actions the principal may be asked to spot-check (#2159 Phase 3).
//
// Pool rows are ordinary autonomy_action_log rows with outcome 'success'. They are written
// with scored_by = 'sample-pool' so the nightly LLM judge (findUnscoredTerminal) never grades
// them, and with every flag null so the scorer ignores them until the principal gives a
// verdict. Only the principal's verdict scores a sampled action (decision of 2026-10-19).

import { AutonomyService } from './autonomy-service.js';
import { HUMAN_SEND_SKILLS } from './band-policy.js';
import type { ActionRisk } from '../skills/types.js';

export const SAMPLE_POOL_SCORED_BY = 'sample-pool';
export const PRINCIPAL_SCORED_BY = 'principal';

/** Mail triage: archiving, labelling or moving the principal's mail. Sampled at any risk. */
export const TRIAGE_SKILLS: ReadonlySet<string> = new Set([
  'ceo-inbox-archive', 'ceo-inbox-label', 'ceo-inbox-update-folders', 'email-archive', 'email-label',
]);

// Medium-risk tools with no effect outside Curia: reading a file is not an action to check.
const NOT_SAMPLED: ReadonlySet<string> = new Set(['file-parse']);

// The gateway records every send (skill or relay) with the review's signals; the
// execution layer must not record them a second time.
const RECORDED_BY_GATEWAY: ReadonlySet<string> = new Set([...HUMAN_SEND_SKILLS, 'dispatcher-relay']);

export interface SampleSignals {
  /** Band review said the send speaks for the principal. */
  speaksAsPrincipal?: boolean;
  /** No contact existed for the recipient at send time. */
  firstContact?: boolean;
  review?: 'bounced' | 'trimmed' | 'unreviewed';
  /** Band Gate C let it through where the tier would have asked. */
  gateProceeded?: boolean;
  triage?: boolean;
}

export interface SampledActionInsert {
  taskId: string;
  conversationId?: string;
  toolName: string;
  actionRisk: string;
  /** What the principal reads in the spot check, e.g. 'Emailed dana@example.com: "Re: Payment schedule"'. */
  summary: string;
  signals: SampleSignals;
}

/** Whether the execution layer records a successful autonomous call of this tool in the pool. */
export function isSampledTool(toolName: string, actionRisk: ActionRisk): boolean {
  if (RECORDED_BY_GATEWAY.has(toolName) || NOT_SAMPLED.has(toolName)) return false;
  if (TRIAGE_SKILLS.has(toolName)) return true;
  return AutonomyService.minScoreForActionRisk(actionRisk) >= AutonomyService.minScoreForActionRisk('medium');
}
