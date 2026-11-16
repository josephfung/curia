// kg-health.ts — why the knowledge graph (entity memory) is on or off, for /api/health.
//
// Boot decides once whether entity memory can run (resolveKnowledgeGraphEmbedding).
// This holds that verdict as a small mutable value so the health endpoint can report
// it, and so a later runtime check (the weights drift canary) can set it again.
// Dependency-free on purpose: it is read on every health request.

import type { CheckResult } from '../health/types.js';
import type { KnowledgeGraphEmbedding } from './embedding-schema.js';
import type { DriftOutcome } from './embedding-drift.js';

export type KnowledgeGraphReason =
  | 'no_model'
  | 'no_profile'
  | 'non_bundled_model_without_base_url'
  | 'stored_model_without_endpoint'
  | 'implicit_openai_without_key'
  | 'bundled_weights_missing'
  // The bundled files exist but would not load (corrupt file, native runtime failure).
  | 'bundled_load_failed'
  | 'width_mismatch'
  | 'model_mismatch'
  | 'reembed_in_progress'
  | 'schema_check_failed'
  | 'weights_changed'
  | 'implicit_openai_deprecated'
  | 'drift_unchecked'
  | 'weights_shifted';

/** Reasons a drift check (boot or canary) sets. Every other ok reason is a base reason. */
const DRIFT_REASONS: ReadonlySet<KnowledgeGraphReason> = new Set<KnowledgeGraphReason>([
  'drift_unchecked',
  'weights_shifted',
  'weights_changed',
]);

/** A health verdict: what to report now, and the ok reason a drift finding sits on top of. */
export interface KnowledgeGraphVerdict {
  result: 'ok' | 'fail';
  reason?: KnowledgeGraphReason;
  /**
   * Set only when a drift finding (`reason`) hides an ok reason of its own, such as the
   * implicit-OpenAI deprecation. The canary restores it once the drift check passes.
   */
  baseReason?: KnowledgeGraphReason;
}

export class KnowledgeGraphHealth {
  private result: CheckResult = 'ok';
  private reason: KnowledgeGraphReason | undefined;
  /**
   * The ok reason that is not a drift finding (today only `implicit_openai_deprecated`),
   * kept apart from `reason` so a canary `same` after `drift_unchecked` can restore it.
   * Without this, a boot verdict of `drift_unchecked` would lose the deprecation for good
   * (#2023 review).
   */
  private baseReason: KnowledgeGraphReason | undefined;

  set(result: 'ok' | 'fail', reason?: KnowledgeGraphReason): void {
    this.result = result;
    this.reason = reason;
    // A drift reason leaves the base alone: it is reported on top of it. Anything else
    // replaces it (a failed graph has no ok reason to come back to).
    if (result === 'fail') this.baseReason = undefined;
    else if (reason === undefined || !DRIFT_REASONS.has(reason)) this.baseReason = reason;
  }

  /** Applies the boot verdict, including the base reason a drift finding hides. */
  setVerdict(verdict: KnowledgeGraphVerdict): void {
    this.set(verdict.result, verdict.reason);
    if (verdict.result === 'ok' && verdict.baseReason !== undefined) this.baseReason = verdict.baseReason;
  }

  get(): { result: CheckResult; reason?: KnowledgeGraphReason } {
    return this.reason ? { result: this.result, reason: this.reason } : { result: this.result };
  }

  /**
   * Applies the embeddings canary's re-run of the endpoint drift check (design §7). The
   * knowledge graph is never switched off mid-run (there is no runtime toggle); only the
   * verdict changes. A found change or shift sticks until a restart after
   * `pnpm reembed:kg --force`: vectors written meanwhile came from those weights, so a later
   * `same` does not make them right. A graph already off for another reason is left alone.
   */
  recordDrift(outcome: DriftOutcome): void {
    // Off for another reason, or a change already found (`weights_changed` is always `fail`).
    if (this.result === 'fail') return;
    switch (outcome) {
      case 'changed':
        this.set('fail', 'weights_changed');
        return;
      case 'shifted':
        this.set('ok', 'weights_shifted');
        return;
      case 'unchecked':
        // A check that could not run says nothing new about a shift already found.
        if (this.reason === 'weights_shifted' || this.reason === 'drift_unchecked') return;
        this.set('ok', 'drift_unchecked');
        return;
      case 'same':
        // Back to the base reason (the deprecation, when there is one), not to nothing.
        if (this.reason === 'drift_unchecked') this.set('ok', this.baseReason);
        return;
    }
  }
}

/**
 * Maps the boot resolution to a health verdict. Maps by the structured codes only
 * (gate, reason, state.reason), never by message text.
 */
export function knowledgeGraphReasonFrom(kg: KnowledgeGraphEmbedding): KnowledgeGraphVerdict {
  if (kg.ok) {
    const deprecated: KnowledgeGraphReason | undefined =
      kg.deprecation === 'implicit_openai' ? 'implicit_openai_deprecated' : undefined;
    // One reason is reported. A drift finding is what an operator must act on, so it goes
    // first, and the deprecation it hides rides along as the base reason.
    const drift: KnowledgeGraphReason | undefined =
      kg.drift === 'shifted' ? 'weights_shifted' : kg.drift === 'unchecked' ? 'drift_unchecked' : undefined;
    if (drift) return deprecated ? { result: 'ok', reason: drift, baseReason: deprecated } : { result: 'ok', reason: drift };
    return deprecated ? { result: 'ok', reason: deprecated } : { result: 'ok' };
  }
  switch (kg.gate) {
    case 'config':
    case 'bundled':
      return { result: 'fail', reason: kg.reason };
    case 'schema': {
      // The instance-lock holder case: `pnpm reembed:kg` is running, no state.
      if (kg.reason === 'reembed_in_progress') return { result: 'fail', reason: 'reembed_in_progress' };
      if (kg.state) {
        // An unfinished run is the same operator situation as the lock holder.
        return { result: 'fail', reason: kg.state.reason === 'open_run' ? 'reembed_in_progress' : kg.state.reason };
      }
      return { result: 'fail', reason: 'schema_check_failed' };
    }
    case 'drift':
      return { result: 'fail', reason: kg.reason };
  }
}
