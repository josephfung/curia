// Which installs see the Setup page (#2358), and the PUT /api/setup/state body rules.
import { describe, it, expect } from 'vitest';
import { EMPTY_SETUP_STATE, isInSetup } from '../../../src/setup/setup-state.js';
import { parseStateUpdate } from '../../../src/channels/http/routes/setup.js';

describe('isInSetup', () => {
  it('a brand-new install (nothing saved, no identity) is in Setup', () => {
    expect(isInSetup(EMPTY_SETUP_STATE, false)).toBe(true);
  });

  it('an install that predates the Setup page (no phase, identity configured) never is', () => {
    expect(isInSetup(EMPTY_SETUP_STATE, true)).toBe(false);
  });

  it('stays in Setup after Curia\'s name is saved, until Start onboarding', () => {
    expect(isInSetup({ ...EMPTY_SETUP_STATE, phase: 'in_progress' }, true)).toBe(true);
  });

  it('is out of Setup once complete', () => {
    expect(isInSetup({ ...EMPTY_SETUP_STATE, phase: 'complete' }, true)).toBe(false);
    expect(isInSetup({ ...EMPTY_SETUP_STATE, phase: 'complete' }, false)).toBe(false);
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
    ['a bad email', { operatorEmail: 'nope' }],
    ['a non-string name', { operatorName: 4 }],
    ['an over-long name', { operatorName: 'x'.repeat(201) }],
    ['nothing at all', {}],
  ])('refuses %s', (_name, body) => {
    expect(parseStateUpdate(body)).toHaveProperty('error');
  });
});
