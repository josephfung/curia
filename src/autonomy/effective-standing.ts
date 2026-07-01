// effective-standing.ts — the score-keyed bypass ladder for woken/derived tasks (#1125).
//
// Separates LINEAGE (the chain's original TaskOriginator, stamped on the tasks row — pure
// audit + the ceiling for inheritance) from STANDING (what THIS execution context may do).
//
// A live turn carries its lineage as standing unchanged. A heartbeat-woken execution carries a
// `wakeContext` marker (stamped by the scheduler when it fires a BacklogHeartbeat-minted wake);
// for those, the live autonomy score can only ever DOWNGRADE lineage standing to `agent`
// (propose-only) — never upgrade it. This is the safe form of originator-threading: inheriting
// standing is dangerous only at low trust, and gating it on the live score maps the hazard onto
// "the CEO has signalled how freely Curia may act autonomously."
//
// See docs/specs/14-autonomy-engine.md (Effective standing / bypass ladder).

import type { TaskOriginator } from '../contacts/types.js';

/**
 * Bypass-ladder thresholds (raw autonomy scores, NOT coupled to the autonomy engine's band
 * names). Tunable per deployment; defaults below.
 */
export interface BypassLadderConfig {
  /** Min live score for a SAME-TASK heartbeat wake to keep lineage standing (posture B).
   *  Below this, the wake downgrades to agent (posture A). Default 70.
   *  Should not drop below 60: keeping principal standing on a wake activates the
   *  principal-bypass, and letting that fire under restricted mode (<60) would let a woken
   *  task bypass the very block restricted mode exists to enforce. */
  sameTaskThreshold: number;
  /** Min live score for a freshly-derived CHILD task to keep lineage standing (posture D).
   *  Below this, a derived child downgrades to agent. Default 90. */
  derivedChildThreshold: number;
}

export const DEFAULT_BYPASS_LADDER: BypassLadderConfig = {
  sameTaskThreshold: 70,
  derivedChildThreshold: 90,
};

/**
 * Resolve + VALIDATE the bypass-ladder thresholds from raw (possibly local-yaml-overridden)
 * config. The startup JSON-schema validator only checks `default.yaml`, so a local override is
 * otherwise unchecked — and the schema cannot express the cross-field invariant. A misconfigured
 * ladder (inverted, or `same_task` below restricted mode) would let a woken task ride inherited
 * standing at a trust level this model exists to block, so we fail boot loudly rather than run
 * with a silently weakened gate.
 *
 * Invariant: integers, `60 <= same_task <= derived_child <= 100`.
 *  - `same_task >= 60`: keeping standing on a wake activates the principal-bypass; below restricted
 *    mode (60) that would defeat the very block restricted mode enforces.
 *  - `derived_child >= same_task`: a freshly-derived child must never be EASIER to trust than the
 *    original task continuing its own work.
 */
export function resolveBypassLadder(
  raw?: { same_task?: number; derived_child?: number },
): BypassLadderConfig {
  const sameTaskThreshold = raw?.same_task ?? DEFAULT_BYPASS_LADDER.sameTaskThreshold;
  const derivedChildThreshold = raw?.derived_child ?? DEFAULT_BYPASS_LADDER.derivedChildThreshold;
  if (
    !Number.isInteger(sameTaskThreshold) ||
    !Number.isInteger(derivedChildThreshold) ||
    sameTaskThreshold < 60 ||
    derivedChildThreshold > 100 ||
    derivedChildThreshold < sameTaskThreshold
  ) {
    throw new Error(
      `Invalid autonomy.bypass_ladder: require integers with 60 <= same_task <= derived_child <= 100 ` +
        `(got same_task=${String(sameTaskThreshold)}, derived_child=${String(derivedChildThreshold)}).`,
    );
  }
  return { sameTaskThreshold, derivedChildThreshold };
}

/**
 * Marker stamped on a heartbeat wake's agent.task metadata. Its mere PRESENCE signals a
 * non-live (woken) execution → the ladder applies. `derived` picks the ladder column.
 */
export interface WakeContext {
  /** True when the woken task is an agent-spawned child / side-effect task (source='agent' or
   *  parent_task_id set) rather than the original unit of authorized work. Derived children need
   *  the higher (posture-D) threshold to retain lineage standing. */
  derived: boolean;
}

export function makeWakeContext(derived: boolean): WakeContext {
  return { derived };
}

/**
 * Compute the effective task metadata the execution-layer gates should consume.
 *
 * - No metadata, or no `wakeContext` (a live turn): returned unchanged — lineage IS the standing.
 * - `wakeContext` present (a heartbeat wake): apply the ladder against the LIVE score. An
 *   agent/null lineage is already standing-less and returned as-is. A principal/system lineage
 *   is retained when the score clears the relevant threshold, else downgraded to `agent`
 *   (propose-only) — tier dropped so Gate C treats it structurally as agent.
 *
 * A missing live score on a wake path is anomalous (the scheduler that produced the wake implies
 * a running autonomy service) → fail safe by downgrading.
 *
 * The returned object never mutates the input — gates read effective standing; audit logs read
 * the raw lineage.
 */
export function computeEffectiveTaskMetadata(
  metadata: Record<string, unknown> | undefined,
  liveScore: number | null,
  ladder: BypassLadderConfig,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;

  const wakeContext = metadata['wakeContext'] as WakeContext | undefined;
  // Live turn — no ladder. Preserve referential identity so callers can cheaply detect "unchanged".
  if (!wakeContext || typeof wakeContext !== 'object') return metadata;

  const originator = metadata['originator'] as TaskOriginator | undefined;
  if (!originator) return metadata;

  // The ladder only ever DOWNGRADES. agent/null lineage has no standing to lose.
  if (originator.systemRole !== 'principal' && originator.systemRole !== 'system') return metadata;

  // Fail safe toward the conservative (higher) column: anything that isn't explicitly
  // derived === false is treated as a derived child. A wakeContext with a missing/malformed
  // `derived` should require posture D, not the easier posture B.
  const derived = wakeContext.derived !== false;
  const threshold = derived ? ladder.derivedChildThreshold : ladder.sameTaskThreshold;
  const keepsStanding = liveScore !== null && liveScore >= threshold;
  if (keepsStanding) return metadata; // posture B (same-task) or D (derived) — lineage retained

  // Downgrade to agent (propose-only). Preserve the audit fields (who/when/where) but drop
  // standing and tier so isPrincipalOriginated/isSystemOriginated/getInitiatingTier all read
  // "agent, no bypass" off the effective metadata.
  const downgraded: TaskOriginator = { ...originator, systemRole: 'agent', tier: null };
  return { ...metadata, originator: downgraded };
}
