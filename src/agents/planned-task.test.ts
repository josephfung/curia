import { describe, it, expect } from 'vitest';
import {
  buildPlanTaskGuidanceBlock,
  shouldOfferPlanSkill,
} from './planned-task.js';

describe('shouldOfferPlanSkill', () => {
  it('offers plan for complex bound tasks without resumable flag', () => {
    expect(shouldOfferPlanSkill({ errorBudget: {}, progress: {} })).toBe(true);
  });

  it('withholds plan for iterate leaves', () => {
    expect(shouldOfferPlanSkill({ errorBudget: { resumable: true }, progress: {} })).toBe(false);
  });

  it('offers plan when progress.plan is present', () => {
    expect(shouldOfferPlanSkill({
      errorBudget: { resumable: true },
      progress: {
        plan: {
          steps: [{ id: 'a', taskId: '00000000-0000-0000-0000-000000000001' }],
          deliverableStepId: null,
          done: 0,
          total: 1,
          next: 'Run step a',
        },
      },
    })).toBe(true);
  });
});

describe('buildPlanTaskGuidanceBlock', () => {
  it('includes altitude guidance and current plan summary when present', () => {
    const block = buildPlanTaskGuidanceBlock({
      steps: [{ id: 'final', taskId: null }],
      deliverableStepId: 'final',
      done: 2,
      total: 3,
      next: 'Wait on exec input',
    });
    expect(block).toContain('~10 child rows');
    expect(block).toContain('1,300');
    expect(block).toContain('Progress: 2 / 3');
    expect(block).toContain('Deliverable step: `final`');
  });
});
