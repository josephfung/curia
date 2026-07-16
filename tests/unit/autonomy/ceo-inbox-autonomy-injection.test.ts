import { describe, it, expect } from 'vitest';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';

/**
 * #1427 — ceo-inbox must receive the autonomy prompt block on scheduled runs.
 * Injection is wired in src/index.ts for agentConfig.name === 'ceo-inbox'.
 * This test locks the band-description contract the agent prompt relies on.
 */
describe('ceo-inbox autonomy band injection (#1427)', () => {
  it('formatPromptBlock describes the live band for triage aggressiveness', () => {
    const low = AutonomyService.formatPromptBlock({
      score: 40,
      band: 'draft-only',
      updatedAt: new Date(),
      updatedBy: 'system',
    });
    const high = AutonomyService.formatPromptBlock({
      score: 85,
      band: 'spot-check',
      updatedAt: new Date(),
      updatedBy: 'system',
    });
    expect(low).toMatch(/Autonomy/i);
    expect(low).toMatch(/40/);
    expect(high).toMatch(/85/);
    // Distinct band copy — higher band should not equal lower band text.
    expect(high).not.toEqual(low);
  });

  it('injection predicate includes ceo-inbox alongside coordinator', () => {
    // Assert the *production* predicate (used by src/index.ts to pass autonomyService),
    // not a local copy — otherwise this test stays green even if the wiring regresses.
    expect(
      AutonomyService.receivesInjection({ name: 'coordinator', role: 'coordinator' }),
    ).toBe(true);
    expect(AutonomyService.receivesInjection({ name: 'ceo-inbox', role: 'specialist' })).toBe(true);
    expect(AutonomyService.receivesInjection({ name: 'calendar', role: 'specialist' })).toBe(false);
  });
});
