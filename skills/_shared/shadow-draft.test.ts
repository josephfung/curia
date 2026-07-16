import { describe, it, expect } from 'vitest';
import {
  isHighSensitivityThread,
  scoreDecisionEquivalence,
  detectDecisionPolarity,
  parseShadowDoc,
  SHADOW_DOC_TYPE,
} from './shadow-draft.js';

describe('isHighSensitivityThread', () => {
  it('excludes board / legal / spouse threads from capture', () => {
    expect(isHighSensitivityThread({ subject: 'Board pack for Friday' })).toBe(true);
    expect(isHighSensitivityThread({ subject: 'Hello', body: 'our attorney said' })).toBe(true);
    expect(isHighSensitivityThread({ subject: 'Dinner with spouse' })).toBe(true);
    expect(isHighSensitivityThread({ subject: 'Quick scheduling note' })).toBe(false);
  });
});

describe('scoreDecisionEquivalence', () => {
  it('scores matching decisions as competence_flag=1', () => {
    const result = scoreDecisionEquivalence(
      'I can confirm Thursday at 3pm works. Will send the invite.',
      'Confirming Thursday 3pm — I will send the calendar invite shortly.',
    );
    expect(result.competenceFlag).toBe(1);
  });

  it('scores divergent decisions as competence_flag=0', () => {
    const result = scoreDecisionEquivalence(
      'Happy to approve the $50k budget increase for marketing.',
      'I have to decline the budget increase; we cannot spend more this quarter.',
    );
    expect(result.competenceFlag).toBe(0);
  });

  it('rejects opposing decisions even with high vocabulary overlap', () => {
    // Near-identical wording, opposite decision — must NOT count as competence.
    const result = scoreDecisionEquivalence(
      'I approve the budget increase for the new project this quarter.',
      'I decline the budget increase for the new project this quarter.',
    );
    expect(result.competenceFlag).toBe(0);
    expect(result.reason).toContain('decision-diverged');
  });

  it('does not credit when neither message expresses a decision (moderate overlap)', () => {
    const result = scoreDecisionEquivalence(
      'Here are the quarterly figures you asked about earlier.',
      'Attached are the monthly headcount figures for the team.',
    );
    expect(result.competenceFlag).toBe(0);
  });

  it('does not credit when one side decides and the other stays silent', () => {
    const result = scoreDecisionEquivalence(
      'I approve the proposal and will sign the contract today.',
      'Thanks for the proposal, here is some background on the team.',
    );
    expect(result.competenceFlag).toBe(0);
    expect(result.reason).toContain('decision-asymmetry');
  });
});

describe('detectDecisionPolarity', () => {
  it('reads deny even when an approve verb is negated', () => {
    expect(detectDecisionPolarity('I cannot approve this right now.')).toBe('deny');
    expect(detectDecisionPolarity('Yes, happy to go ahead.')).toBe('affirm');
    expect(detectDecisionPolarity('Here is the report you wanted.')).toBe('none');
  });
});

describe('parseShadowDoc', () => {
  it('skips already-reconciled shadows', () => {
    expect(
      parseShadowDoc({
        type: SHADOW_DOC_TYPE,
        frontmatter: {
          source_message_id: 'm1',
          reconciled_at: '2026-07-01T00:00:00.000Z',
        },
        body: 'hi',
      }),
    ).toBeNull();
  });
});
