import { describe, it, expect } from 'vitest';
import {
  isHighSensitivityThread,
  scoreDecisionEquivalence,
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
