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

/**
 * Mail triage: archiving or labelling the principal's mail. Sampled at any risk.
 *
 * Not ceo-inbox-update-folders: ceo-inbox triage calls it AND ceo-inbox-archive for the same
 * message, so sampling both turned one triage decision into two pool rows. It is low risk,
 * so outside this set it is not sampled at all.
 */
export const TRIAGE_SKILLS: ReadonlySet<string> = new Set([
  'ceo-inbox-archive', 'ceo-inbox-label', 'email-archive', 'email-label',
]);

// Medium-risk tools that would only add noise to the pool.
const NOT_SAMPLED: ReadonlySet<string> = new Set([
  // No effect outside Curia: reading a file is not an action to check.
  'file-parse',
  // One browsing task makes many calls (navigate, click, read), which would flood the pool
  // with steps of a single action. TODO: revisit once a form submission is distinguishable
  // from navigation, since a submission is worth spot-checking.
  'web-browser',
  // Only queues a writing-voice proposal; the principal approves it before anything changes.
  'voice-learn',
]);

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
  /** The tool's input, kept on the row when its JSON is at most 2000 characters. */
  input?: Record<string, unknown>;
}

/** Whether the execution layer records a successful autonomous call of this tool in the pool. */
export function isSampledTool(toolName: string, actionRisk: ActionRisk): boolean {
  if (RECORDED_BY_GATEWAY.has(toolName) || NOT_SAMPLED.has(toolName)) return false;
  if (TRIAGE_SKILLS.has(toolName)) return true;
  return AutonomyService.minScoreForActionRisk(actionRisk) >= AutonomyService.minScoreForActionRisk('medium');
}
