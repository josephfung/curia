/**
 * Gate C for the dispatcher auto-reply relay (#1733).
 *
 * The execution-layer reply skills (email-reply, etc.) already enforce Gate C.
 * handleAgentResponse used to publish outbound.message with no tier check, so a
 * skill-level escalate quietly diverted the send onto an ungated path. This
 * module applies the same tier × consequence policy to the relay, treating it
 * as a reply-to-sender medium-risk send (reversible-external, not third-party).
 */

import type { ContactTier, TaskOriginator } from '../contacts/types.js';
import { getInitiatingTier, isExternalOriginatorMissingTier } from '../contacts/principal.js';
import {
  applyActionPolicy,
  mapActionRiskToConsequenceClass,
  type EscalationDecision,
} from '../autonomy/escalation-policy.js';

/** Human-facing outbound skills whose Gate C escalate must suppress the relay. */
export const REPLY_SKILLS_GATE_C = new Set([
  'email-reply',
  'email-send',
  'signal-send',
  'sms-send',
  'slack-send',
]);

/** Audit `action` value for authorization.decision emitted on the relay path. */
export const RELAY_GATE_C_ACTION = 'dispatcher-relay';

/** action_risk equivalent for a relayed agent.response reply. */
export const RELAY_ACTION_RISK = 'medium' as const;

export type RelayGateCOutcome =
  | { kind: 'skip'; reason: 'no_external_originator' | 'system_or_agent' }
  | {
      kind: 'decide';
      decision: EscalationDecision;
      tier: ContactTier | 'unresolved';
      reason: string;
    };

/**
 * Decide Gate C for a dispatcher-relayed reply to the inbound sender.
 *
 * Mirrors ExecutionLayer.resolveTierGateDecision for action_risk medium without
 * re-running the EscalationJudge on this hot path. When reply-to-sender vs
 * third-party-facing would change the outcome (known × reversible-external),
 * fail closed — escalate — matching email-reply with no judge wired. That is
 * the cell named by #1733's "known-tier third-party relay escalates" criterion
 * and closes the ungated auto-reply hole for known contacts. Unambiguous cells
 * (principal / trusted allow; unknown / blocked escalate) decide deterministically.
 * Principal-sole-recipient carve-out (#1301) does not apply: the relay recipient
 * *is* the initiator.
 */
export function decideRelayGateC(originator: TaskOriginator | undefined): RelayGateCOutcome {
  if (!originator) {
    return { kind: 'skip', reason: 'no_external_originator' };
  }

  const metadata: Record<string, unknown> = { originator };
  const initiatingTier = getInitiatingTier(metadata);

  if (initiatingTier === null) {
    if (isExternalOriginatorMissingTier(metadata)) {
      return {
        kind: 'decide',
        decision: 'escalate',
        tier: 'unresolved',
        reason: 'external_originator_missing_tier',
      };
    }
    return { kind: 'skip', reason: 'system_or_agent' };
  }

  const actionClass = mapActionRiskToConsequenceClass(RELAY_ACTION_RISK);
  const decisionIfReplyToSender = applyActionPolicy(initiatingTier, actionClass, false, false);
  const decisionIfThirdParty = applyActionPolicy(initiatingTier, actionClass, true, false);

  // Ambiguous cell (known × reversible-external): fail closed without a judge.
  if (decisionIfReplyToSender !== decisionIfThirdParty) {
    return {
      kind: 'decide',
      decision: 'escalate',
      tier: initiatingTier,
      reason: 'third_party_axis_ambiguous_fail_closed',
    };
  }

  return {
    kind: 'decide',
    decision: decisionIfReplyToSender,
    tier: initiatingTier,
    reason:
      decisionIfReplyToSender === 'allow' ? 'tier_permits_external_send' : 'tier_requires_approval',
  };
}

/**
 * True when a failed tool.result error string indicates a Gate C (tier) block
 * rather than a score gate or handler failure.
 */
export function isGateCBlockError(error: unknown): boolean {
  if (typeof error !== 'string') return false;
  return (
    error.includes("initiating contact's tier") ||
    error.includes('external originator has no resolved tier') ||
    error.includes('failed to audit Gate C authorization.decision') ||
    error.includes('untrusted external originator')
  );
}
