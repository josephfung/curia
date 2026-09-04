/**
 * Gate C for the dispatcher auto-reply relay (#1733).
 *
 * The execution-layer reply skills (email-reply, etc.) already enforce Gate C.
 * handleAgentResponse used to publish outbound.message with no tier check, so a
 * skill-level escalate quietly diverted the send onto an ungated path. This
 * module applies the same tier × consequence policy to the relay, consulting the
 * EscalationJudge when the third-party axis is ambiguous (known × reversible-
 * external) — matching ExecutionLayer.resolveTierGateDecision.
 */

import type { ContactTier, TaskOriginator } from '../contacts/types.js';
import { getInitiatingTier, isExternalOriginatorMissingTier } from '../contacts/principal.js';
import {
  applyActionPolicy,
  mapActionRiskToConsequenceClass,
  moreSevereConsequence,
  type EscalationDecision,
} from '../autonomy/escalation-policy.js';
import type { EscalationJudge } from '../autonomy/escalation-judge.js';

/** Human-facing outbound skills whose Gate C escalate must suppress the relay. */
export const REPLY_SKILLS_GATE_C = new Set([
  'email-reply',
  'email-send',
  'signal-send',
  'sms-send',
  'slack-send',
  'dispatcher-relay',
]);

/** Audit `action` on authorization.decision for the relay path.
 * Approval rows use the same name so approve-action re-invokes the
 * `dispatcher-relay` skill (which publishes the withheld outbound.message).
 */
export const RELAY_GATE_C_ACTION = 'dispatcher-relay';

/** Terminal HTTP/EventRouter status when Gate C withholds the real reply (#1733). */
export const RELAY_GATE_C_HTTP_PENDING_MESSAGE =
  'Approval required — Curia withheld this reply pending CEO approval (contact-tier gate).';

/** action_risk equivalent for a relayed agent.response reply. */
export const RELAY_ACTION_RISK = 'medium' as const;

export type RelayGateCOutcome =
  | { kind: 'skip'; reason: 'originator_absent' | 'system_or_agent' }
  | {
      kind: 'decide';
      decision: EscalationDecision;
      tier: ContactTier | 'unresolved';
      reason: string;
    };

export interface DecideRelayGateCOptions {
  originator: TaskOriginator | undefined;
  /** Reply body — fed to the EscalationJudge description when the axis is ambiguous. */
  content: string;
  conversationId: string;
  channelId: string;
  /** When wired and enabled, resolves known × reversible-external like email-reply. */
  escalationJudge?: EscalationJudge;
}

/**
 * Decide Gate C for a dispatcher-relayed reply.
 *
 * Mirrors ExecutionLayer.resolveTierGateDecision for action_risk medium:
 * deterministic when reply-to-sender vs third-party agree; otherwise consult
 * the EscalationJudge (fail closed when absent/disabled/undetermined).
 * Principal-sole-recipient carve-out (#1301) does not apply: the relay
 * recipient *is* the initiator.
 */
export async function decideRelayGateC(
  opts: DecideRelayGateCOptions,
): Promise<RelayGateCOutcome> {
  const { originator, content, conversationId, channelId, escalationJudge } = opts;

  if (!originator) {
    return { kind: 'skip', reason: 'originator_absent' };
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

  if (decisionIfReplyToSender === decisionIfThirdParty) {
    return {
      kind: 'decide',
      decision: decisionIfReplyToSender,
      tier: initiatingTier,
      reason:
        decisionIfReplyToSender === 'allow' ? 'tier_permits_external_send' : 'tier_requires_approval',
    };
  }

  // Ambiguous cell (known × reversible-external): consult the judge, same as email-reply.
  if (escalationJudge?.isEnabled()) {
    const excerpt = content.length > 500 ? `${content.slice(0, 500)}…` : content;
    const verdict = await escalationJudge.classifyAction({
      description:
        `Dispatcher auto-reply on channel '${channelId}' to the inbound sender. ` +
        `The email adapter may reply-all (CC thread participants). Body:\n${excerpt}`,
      initiatingTier,
      conversationId,
    });
    if (verdict.isThirdPartyFacing === undefined) {
      return {
        kind: 'decide',
        decision: 'escalate',
        tier: initiatingTier,
        reason: 'judge_no_third_party_determination',
      };
    }
    const effectiveClass = moreSevereConsequence(actionClass, verdict.actionClass ?? actionClass);
    const decision = applyActionPolicy(
      initiatingTier,
      effectiveClass,
      verdict.isThirdPartyFacing,
      false,
    );
    return {
      kind: 'decide',
      decision,
      tier: initiatingTier,
      reason: verdict.isThirdPartyFacing
        ? 'judge_third_party_facing'
        : 'judge_reply_to_sender',
    };
  }

  return {
    kind: 'decide',
    decision: 'escalate',
    tier: initiatingTier,
    reason: 'third_party_axis_ambiguous_no_judge',
  };
}

/** Build the approval payload for the dispatcher-relay skill (approve-action re-exec). */
export function buildRelayApprovalInput(args: {
  channelId: string;
  senderId: string;
  content: string;
  conversationId: string;
  accountId?: string;
}): Record<string, unknown> {
  return {
    channelId: args.channelId,
    to: args.senderId,
    body: args.content,
    conversationId: args.conversationId,
    ...(args.accountId ? { accountId: args.accountId } : {}),
  };
}
