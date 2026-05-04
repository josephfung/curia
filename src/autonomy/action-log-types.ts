// action-log-types.ts — TypeScript types for the autonomy_action_log table.
//
// These mirror the Postgres schema from migration 031. The scoring engine,
// approval lifecycle skills (#427/#428), and the DreamEngine scoring pass
// all import from here.

/** Terminal outcomes that the scoring pass evaluates. */
export const TERMINAL_OUTCOMES = [
  'success',
  'failure',
  'rejected',       // ← add this; DETERMINISTIC_SCORES has a rejected entry but it was never fetched
  'approved',
  'denied',
  'expired',
  'resolved_externally',
] as const;

/** Outcomes that require an LLM judge call (not deterministically scorable). */
export const LLM_SCORED_OUTCOMES = ['success', 'failure'] as const;

/** All valid outcome values for the autonomy_action_log.outcome column. */
export type ActionLogOutcome =
  | 'success'
  | 'failure'
  | 'rejected'
  | 'pending_approval'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'resolved_externally';

/** A row from autonomy_action_log. */
export interface ActionLogRow {
  id: number;
  taskId: string;
  conversationId: string | null;
  skillName: string;
  actionRisk: string;
  outcome: ActionLogOutcome;
  taskSummary: string | null;

  competenceFlag: 0 | 1 | null;
  commitmentFlag: 0 | 1 | null;
  compatibility: 0 | 1 | null;
  scoredBy: string | null;

  // Approval lifecycle (populated by #427/#428/#429)
  payload: Record<string, unknown> | null;
  notificationSentAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  expiresAt: Date | null;
  parentActionId: number | null;
  shortRef: string | null;
  description: string | null;

  createdAt: Date;
}

/** Fields required to insert a new autonomy_action_log row. */
export interface ActionLogInsert {
  taskId: string;
  conversationId?: string;
  skillName: string;
  actionRisk: string;
  outcome: ActionLogOutcome;
  taskSummary?: string;

  // Approval lifecycle fields (optional — used by #427/#428)
  payload?: Record<string, unknown>;
  expiresAt?: Date;
  shortRef?: string;
  description?: string;
  /** Links a re-execution row back to the approved row. Used by approve-action (#428). */
  parentActionId?: number;
}

/** Scoring flags written by the scoring pass or deterministic scorer. */
export interface ScoringFlags {
  competenceFlag: 0 | 1 | null;
  commitmentFlag: 0 | 1 | null;
  compatibility: 0 | 1 | null;
  scoredBy: string;
}

/**
 * Deterministic scoring table for approval/gate outcomes.
 * These outcomes carry inherent trust signals from the CEO's decision
 * (or the gate's decision) and do not need LLM interpretation.
 *
 * null means "no signal for this dimension" — the row is excluded from
 * that dimension's weighted average rather than dragging it toward zero.
 */
export const DETERMINISTIC_SCORES: Record<string, ScoringFlags> = {
  approved:            { competenceFlag: 1, commitmentFlag: 1, compatibility: 1,    scoredBy: 'deterministic' },
  denied:              { competenceFlag: 0, commitmentFlag: null, compatibility: 0, scoredBy: 'deterministic' },
  expired:             { competenceFlag: null, commitmentFlag: 1, compatibility: 0, scoredBy: 'deterministic' },
  resolved_externally: { competenceFlag: 1, commitmentFlag: 1, compatibility: null, scoredBy: 'deterministic' },
  rejected:            { competenceFlag: 0, commitmentFlag: 1, compatibility: null, scoredBy: 'deterministic' },
};
