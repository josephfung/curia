// escalation-policy.ts — Tier × sensitivity/consequence → allow/escalate policy tables.
//
// This module owns the canonical policy definitions for the escalation-line (issue #948).
// Rubric: (reversibility class) × (stakes magnitude) × (initiating tier) → allow / escalate.
//
// Design intent:
//   - The LLM judge (escalation-judge.ts) classifies natural language into the typed
//     classes below.
//   - The deterministic functions here apply the policy — no LLM in the hot path.
//   - Both the disclosure gate (#949) and action gate (#950) import from this module.

import type { ContactTier } from '../contacts/types.js';
import { meetsMinimumTier, TIER_RANK } from '../contacts/types.js';

// ---------------------------------------------------------------------------
// Disclosure-sensitivity classes
// ---------------------------------------------------------------------------

/**
 * How sensitive is the information being disclosed?
 *
 * Ordered ascending by sensitivity (public is least, confidential is most).
 * Policy source: issue #948, contacts redesign milestone v0.36.
 */
export type DisclosureClass =
  // "best to email", confirming a meeting exists — safe to share widely.
  | 'public'
  // His location, availability detail, his opinion — principal metadata.
  | 'principal-context'
  // Anything about another contact — protected until recipient is trusted.
  | 'third-party'
  // Financials, legal, private-thread content.
  | 'confidential';

// ---------------------------------------------------------------------------
// Action-consequence classes
// ---------------------------------------------------------------------------

/**
 * What is the consequence class of a proposed action?
 *
 * Reversibility is the primary axis. "Drafting is not an action; the send is."
 * Policy source: issue #948.
 */
export type ActionConsequenceClass =
  // Read, summarize, lookup — no external effect.
  | 'none'
  // Draft, reminder, note — internal, easily undone.
  | 'reversible-internal'
  // Send a reply, calendar invite to others, make a commitment.
  | 'reversible-external'
  // Payment, permanent deletion — cannot be undone.
  | 'irreversible';

export type EscalationDecision = 'allow' | 'escalate';

// ---------------------------------------------------------------------------
// Disclosure policy
// ---------------------------------------------------------------------------

/**
 * Which disclosure classes each tier is permitted to receive.
 *
 * Policy (issue #948 resolved section):
 *   blocked   — nothing; blocked contacts are dropped upstream but guarded here.
 *   unknown   — public/logistics only. Availability is principal-context and escalates.
 *   known     — + principal availability and light context. No third-party, no confidential.
 *   trusted   — all classes, including confidential. Third-party PII stops escalating here.
 *   principal — all classes (the CEO sees everything).
 */
const DISCLOSURE_ALLOWED: Record<ContactTier, ReadonlySet<DisclosureClass>> = {
  blocked:   new Set<DisclosureClass>(),
  unknown:   new Set<DisclosureClass>(['public']),
  known:     new Set<DisclosureClass>(['public', 'principal-context']),
  trusted:   new Set<DisclosureClass>(['public', 'principal-context', 'third-party', 'confidential']),
  principal: new Set<DisclosureClass>(['public', 'principal-context', 'third-party', 'confidential']),
};

/**
 * Determine whether a disclosure of the given class is allowed for a recipient at the
 * given tier.
 *
 * Third-party info escalates for all tiers below 'trusted' — this is enforced by the
 * table above without a special case.
 */
export function applyDisclosurePolicy(
  recipientTier: ContactTier,
  disclosureClass: DisclosureClass,
): EscalationDecision {
  const allowed = DISCLOSURE_ALLOWED[recipientTier];
  // Belt-and-suspenders: unrecognized tier not in the table → fail closed.
  if (!allowed) return 'escalate';
  return allowed.has(disclosureClass) ? 'allow' : 'escalate';
}

// ---------------------------------------------------------------------------
// Action policy
// ---------------------------------------------------------------------------

/**
 * Determine whether an action of the given class is allowed for the contact who initiated
 * the task.
 *
 * @param initiatingTier     - Tier of the contact who triggered this task.
 * @param actionClass        - Consequence class of the proposed action.
 * @param isThirdPartyFacing - For 'reversible-external' only: true when the action
 *                             targets parties OTHER than the initiating sender (e.g.
 *                             inviting a new attendee, emailing someone new, committing
 *                             on the principal's behalf to external parties). A plain reply
 *                             to the sender is false.
 *
 * Policy (issue #948 resolved section):
 *   blocked   — nothing; blocked contacts cannot initiate tasks.
 *   unknown   — read-only and drafting only. Any external send/resource write escalates.
 *   known     — reply to sender is fine; third-party-facing external actions escalate.
 *   trusted   — reversible-external within granted bounds; only irreversible escalates.
 *   principal — everything allowed.
 *
 * Note: a plain reply to the initiating sender is governed by the DISCLOSURE gate
 * (what the reply says), not this action gate, to avoid double-counting the same message.
 */
/**
 * Map a skill manifest's action_risk label to the canonical ActionConsequenceClass.
 *
 * This intentionally returns ONLY the consequence class — NOT isThirdPartyFacing. The
 * manifest's action_risk encodes reversibility/consequence, fixed once at skill-authoring
 * time; it cannot encode WHO a given invocation targets. A `medium` outbound skill may
 * reply to the initiating sender OR email a third party — same manifest, different
 * isThirdPartyFacing. That axis is a runtime property of the actual action and must be
 * determined per-invocation (by the EscalationJudge), never baked into a static label.
 * See the Gate C resolution in execution.ts, which only consults the judge when the
 * decision actually hinges on this flag.
 *
 * Mapping follows the policy ladder from issue #948:
 *   none     → read/summarise      → 'none'
 *   low      → internal write      → 'reversible-internal'
 *   medium   → outbound comms      → 'reversible-external'
 *   high     → calendar/commitment → 'reversible-external'
 *   critical → payment/deletion    → 'irreversible'
 *
 * Numeric risks: treated as 'irreversible' (fail-closed — numeric values are
 * author-specified precision scores with no canonical consequence class, so they always
 * escalate for non-principal tiers). No skill uses numeric action_risk today.
 * @TODO(#950): route numeric risks through the EscalationJudge instead of fail-closing.
 */
export function mapActionRiskToConsequenceClass(
  risk: 'none' | 'low' | 'medium' | 'high' | 'critical' | number,
): ActionConsequenceClass {
  if (typeof risk === 'number') return 'irreversible';
  switch (risk) {
    case 'none':     return 'none';
    case 'low':      return 'reversible-internal';
    case 'medium':   return 'reversible-external';
    case 'high':     return 'reversible-external';
    case 'critical': return 'irreversible';
    // Belt-and-suspenders: an unrecognized label fails closed (mirrors applyActionPolicy).
    default:         return 'irreversible';
  }
}

export function applyActionPolicy(
  initiatingTier: ContactTier,
  actionClass: ActionConsequenceClass,
  isThirdPartyFacing: boolean,
): EscalationDecision {
  // Belt-and-suspenders: unrecognized tier → fail closed (mirrors applyDisclosurePolicy guard).
  // TIER_RANK is the canonical tier registry; a tier absent from it is not a valid ContactTier.
  if (!(initiatingTier in TIER_RANK)) return 'escalate';

  if (initiatingTier === 'blocked') return 'escalate';

  // Principal bypasses all action gates — the CEO can request anything.
  if (meetsMinimumTier(initiatingTier, 'principal')) return 'allow';

  switch (actionClass) {
    case 'none':
    case 'reversible-internal':
      // Read-only and internal writes (drafting, reminders, notes) are always allowed.
      return 'allow';

    case 'reversible-external':
      if (meetsMinimumTier(initiatingTier, 'trusted')) return 'allow';
      if (meetsMinimumTier(initiatingTier, 'known')) {
        // Known contacts: reply to the sender is fine; third-party-facing escalates.
        return isThirdPartyFacing ? 'escalate' : 'allow';
      }
      // Unknown: any external send escalates.
      return 'escalate';

    case 'irreversible':
      // Irreversible always escalates (principal bypass handled above).
      return 'escalate';

    default:
      // Belt-and-suspenders: unrecognized action class → fail closed.
      return 'escalate';
  }
}
