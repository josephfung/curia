// Which installs see the Setup page (#2358, #2709), and the PUT /api/setup/state body rules.
import { describe, it, expect } from 'vitest';
import { EMPTY_SETUP_STATE, MIGRATION_SETUP_ACTOR, isInSetup } from '../../../src/setup/setup-settings.js';
import { parseStateUpdate } from '../../../src/channels/http/routes/setup.js';

describe('MIGRATION_SETUP_ACTOR', () => {
  it('matches the updated_by migration 132 records', () => {
    // The migration SQL has the same literal; a rename there must change this too.
    expect(MIGRATION_SETUP_ACTOR).toBe('migration:132');
  });
});

describe('isInSetup', () => {
  it('a brand-new install that has saved nothing is in Setup', () => {
    expect(isInSetup(EMPTY_SETUP_STATE.phase)).toBe(true);
  });

  it('stays in Setup until Start onboarding', () => {
    expect(isInSetup('in_progress')).toBe(true);
  });

  it('is out of Setup once complete (also how migration 132 marks older installs)', () => {
    expect(isInSetup('complete')).toBe(false);
  });
});

describe('parseStateUpdate', () => {
  it('accepts a partial update and normalizes the operator email', () => {
    expect(parseStateUpdate({ setupFor: 'other', operatorName: '  Sam  ', operatorEmail: 'Sam@Example.com' })).toEqual({
      update: { setupFor: 'other', operatorName: 'Sam', operatorEmail: 'sam@example.com' },
    });
  });

  it('accepts each route and null to clear one', () => {
    for (const messagingRoute of ['app', 'signal', 'sms', 'slack']) {
      expect(parseStateUpdate({ messagingRoute })).toEqual({ update: { messagingRoute } });
    }
    expect(parseStateUpdate({ voiceRoute: null })).toEqual({ update: { voiceRoute: null } });
  });

  it('reads an empty name as cleared', () => {
    expect(parseStateUpdate({ operatorName: '   ' })).toEqual({ update: { operatorName: null } });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['an unknown field', { phase: 'complete' }],
    ['a bad route', { messagingRoute: 'telnyx-voice' }],
    ['a voice route Setup does not offer', { voiceRoute: 'sms' }],
    ['a bad setupFor', { setupFor: 'team' }],
    ['a null setupFor', { setupFor: null }],
    ['a bad email', { operatorEmail: 'nope' }],
    ['a non-string name', { operatorName: 4 }],
    ['an over-long name', { operatorName: 'x'.repeat(201) }],
    ['nothing at all', {}],
  ])('refuses %s', (_name, body) => {
    expect(parseStateUpdate(body)).toHaveProperty('error');
  });
});
