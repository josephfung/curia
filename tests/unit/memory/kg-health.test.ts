import { describe, it, expect } from 'vitest';
import { KnowledgeGraphHealth, knowledgeGraphReasonFrom } from '../../../src/memory/kg-health.js';
import type { KnowledgeGraphEmbedding } from '../../../src/memory/embedding-schema.js';

// Failure shapes are built by hand; the mapping reads codes only, never message text.
const fail = (f: Record<string, unknown>) => ({ ok: false, message: 'ignored text', ...f }) as unknown as KnowledgeGraphEmbedding;
const off = (reason: string) => fail({ gate: 'schema', state: { status: 'off', reason } });

describe('knowledgeGraphReasonFrom', () => {
  it.each([
    'no_model',
    'no_profile',
    'non_bundled_model_without_base_url',
    'stored_model_without_endpoint',
    'implicit_openai_without_key',
  ])('maps config gate reason %s', (reason) => {
    expect(knowledgeGraphReasonFrom(fail({ gate: 'config', reason }))).toEqual({ result: 'fail', reason });
  });

  it.each(['bundled_weights_missing', 'bundled_load_failed'])('maps bundled gate reason %s', (reason) => {
    expect(knowledgeGraphReasonFrom(fail({ gate: 'bundled', reason, err: new Error('x') }))).toEqual({ result: 'fail', reason });
  });

  it('maps schema states', () => {
    expect(knowledgeGraphReasonFrom(off('width_mismatch'))).toEqual({ result: 'fail', reason: 'width_mismatch' });
    expect(knowledgeGraphReasonFrom(off('model_mismatch'))).toEqual({ result: 'fail', reason: 'model_mismatch' });
    expect(knowledgeGraphReasonFrom(off('open_run'))).toEqual({ result: 'fail', reason: 'reembed_in_progress' });
  });

  it('maps the instance-lock holder to reembed_in_progress', () => {
    expect(knowledgeGraphReasonFrom(fail({ gate: 'schema', reason: 'reembed_in_progress' })))
      .toEqual({ result: 'fail', reason: 'reembed_in_progress' });
  });

  it('maps a schema check error with no state to schema_check_failed', () => {
    expect(knowledgeGraphReasonFrom(fail({ gate: 'schema', err: new Error('db') })))
      .toEqual({ result: 'fail', reason: 'schema_check_failed' });
  });

  it('maps the drift gate to weights_changed', () => {
    expect(knowledgeGraphReasonFrom(fail({ gate: 'drift', reason: 'weights_changed' })))
      .toEqual({ result: 'fail', reason: 'weights_changed' });
  });

  it('maps a drift finding on an ok graph to ok with a reason, ahead of the deprecation', () => {
    const ok = (f: Record<string, unknown>) => ({ ok: true, ...f }) as unknown as KnowledgeGraphEmbedding;
    expect(knowledgeGraphReasonFrom(ok({ drift: 'shifted' }))).toEqual({ result: 'ok', reason: 'weights_shifted' });
    expect(knowledgeGraphReasonFrom(ok({ drift: 'unchecked' }))).toEqual({ result: 'ok', reason: 'drift_unchecked' });
    // One reason fits: the drift finding is the one an operator must act on.
    // The deprecation it hides is kept as the base reason, for the canary to restore.
    expect(knowledgeGraphReasonFrom(ok({ drift: 'shifted', deprecation: 'implicit_openai' })))
      .toEqual({ result: 'ok', reason: 'weights_shifted', baseReason: 'implicit_openai_deprecated' });
    expect(knowledgeGraphReasonFrom(ok({ drift: 'unchecked', deprecation: 'implicit_openai' })))
      .toEqual({ result: 'ok', reason: 'drift_unchecked', baseReason: 'implicit_openai_deprecated' });
  });

  it('maps ok to ok, and the implicit OpenAI deprecation to ok with a reason', () => {
    expect(knowledgeGraphReasonFrom({ ok: true } as unknown as KnowledgeGraphEmbedding)).toEqual({ result: 'ok' });
    expect(knowledgeGraphReasonFrom({ ok: true, deprecation: 'implicit_openai' } as unknown as KnowledgeGraphEmbedding))
      .toEqual({ result: 'ok', reason: 'implicit_openai_deprecated' });
  });
});

describe('KnowledgeGraphHealth', () => {
  it('starts ok and holds what was last set', () => {
    const h = new KnowledgeGraphHealth();
    expect(h.get()).toEqual({ result: 'ok' });
    h.set('fail', 'width_mismatch');
    expect(h.get()).toEqual({ result: 'fail', reason: 'width_mismatch' });
    h.set('ok');
    expect(h.get()).toEqual({ result: 'ok' });
  });
});

describe('KnowledgeGraphHealth.recordDrift (the canary re-running the check)', () => {
  const at = (result: 'ok' | 'fail', reason?: Parameters<KnowledgeGraphHealth['set']>[1]) => {
    const h = new KnowledgeGraphHealth();
    h.set(result, reason);
    return h;
  };

  it('fails the graph on changed, whatever it said before', () => {
    for (const h of [at('ok'), at('ok', 'drift_unchecked'), at('ok', 'weights_shifted'), at('ok', 'implicit_openai_deprecated')]) {
      h.recordDrift('changed');
      expect(h.get()).toEqual({ result: 'fail', reason: 'weights_changed' });
    }
  });

  it('reports shifted and unchecked as ok with the matching reason', () => {
    const shifted = at('ok');
    shifted.recordDrift('shifted');
    expect(shifted.get()).toEqual({ result: 'ok', reason: 'weights_shifted' });

    const unchecked = at('ok');
    unchecked.recordDrift('unchecked');
    expect(unchecked.get()).toEqual({ result: 'ok', reason: 'drift_unchecked' });
  });

  it('clears a previous drift_unchecked on same, and leaves a clean graph clean', () => {
    const h = at('ok', 'drift_unchecked');
    h.recordDrift('same');
    expect(h.get()).toEqual({ result: 'ok' });

    const clean = at('ok');
    clean.recordDrift('same');
    expect(clean.get()).toEqual({ result: 'ok' });
  });

  it('restores the reason drift_unchecked replaced once the check passes', () => {
    const h = at('ok', 'implicit_openai_deprecated');
    h.recordDrift('unchecked');
    expect(h.get()).toEqual({ result: 'ok', reason: 'drift_unchecked' });
    h.recordDrift('same');
    expect(h.get()).toEqual({ result: 'ok', reason: 'implicit_openai_deprecated' });
  });

  it('restores the deprecation after a boot drift_unchecked once the canary sees same', () => {
    // Boot: the endpoint was unreachable for the drift check, and the OpenAI default applied
    // implicitly. Health reports drift_unchecked; the deprecation must not be lost.
    const ok = { ok: true, drift: 'unchecked', deprecation: 'implicit_openai' } as unknown as KnowledgeGraphEmbedding;
    const h = new KnowledgeGraphHealth();
    h.setVerdict(knowledgeGraphReasonFrom(ok));
    expect(h.get()).toEqual({ result: 'ok', reason: 'drift_unchecked' });
    h.recordDrift('same');
    expect(h.get()).toEqual({ result: 'ok', reason: 'implicit_openai_deprecated' });
  });

  it('never accepts a found shift or change silently: a later same, shifted or unchecked keeps it', () => {
    for (const outcome of ['same', 'unchecked'] as const) {
      const shifted = at('ok', 'weights_shifted');
      shifted.recordDrift(outcome);
      expect(shifted.get()).toEqual({ result: 'ok', reason: 'weights_shifted' });
    }
    for (const outcome of ['same', 'shifted', 'unchecked'] as const) {
      const changed = at('fail', 'weights_changed');
      changed.recordDrift(outcome);
      expect(changed.get()).toEqual({ result: 'fail', reason: 'weights_changed' });
    }
  });

  it('leaves a graph that is off for another reason alone', () => {
    const h = at('fail', 'model_mismatch');
    h.recordDrift('changed');
    expect(h.get()).toEqual({ result: 'fail', reason: 'model_mismatch' });
  });
});
