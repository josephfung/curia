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

export class KnowledgeGraphHealth {
  private result: CheckResult = 'ok';
  private reason: KnowledgeGraphReason | undefined;
  /** The ok reason the canary's `drift_unchecked` replaced, restored when a later check passes. */
  private beforeUnchecked: KnowledgeGraphReason | undefined;

  set(result: 'ok' | 'fail', reason?: KnowledgeGraphReason): void {
    this.result = result;
    this.reason = reason;
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
        this.beforeUnchecked = this.reason;
        this.set('ok', 'drift_unchecked');
        return;
      case 'same':
        if (this.reason === 'drift_unchecked') this.set('ok', this.beforeUnchecked);
        return;
    }
  }
}

/**
 * Maps the boot resolution to a health verdict. Maps by the structured codes only
 * (gate, reason, state.reason), never by message text.
 */
export function knowledgeGraphReasonFrom(
  kg: KnowledgeGraphEmbedding,
): { result: 'ok' | 'fail'; reason?: KnowledgeGraphReason } {
  if (kg.ok) {
    // One reason fits. A drift finding is what an operator must act on, so it goes first.
    if (kg.drift === 'shifted') return { result: 'ok', reason: 'weights_shifted' };
    if (kg.drift === 'unchecked') return { result: 'ok', reason: 'drift_unchecked' };
    return kg.deprecation === 'implicit_openai'
      ? { result: 'ok', reason: 'implicit_openai_deprecated' }
      : { result: 'ok' };
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
