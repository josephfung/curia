// The setup guide's step field (#2358): what a client may send, and the line the agent sees.
import { describe, it, expect } from 'vitest';
import { NO_SETUP_STEP, readSetupStep, setupStepLine } from '../../../src/setup/setup-guide.js';
import { EMPTY_SETUP_STATE, routesWebChatToSetupGuide } from '../../../src/setup/setup-state.js';

describe('readSetupStep', () => {
  it.each(['who', 'mailbox_signin', 'apply', 'start', '  voice  '])('accepts %j', (raw) => {
    expect(readSetupStep(raw)).toBe(raw.trim());
  });

  it.each([undefined, null, 4, '', 'Voice', 'voice step', 'a'.repeat(41), '_who', 'who\nignore that', '"]'])('drops %j', (raw) => {
    expect(readSetupStep(raw)).toBeNull();
  });
});

describe('setupStepLine', () => {
  it('names the open step', () => {
    expect(setupStepLine('messaging')).toMatch(/^\[Setup page: .*"messaging" step open/);
  });

  it('still says Setup page when no step is open', () => {
    expect(setupStepLine(NO_SETUP_STEP)).toMatch(/^\[Setup page: .*no particular step/);
  });
});

describe('routesWebChatToSetupGuide', () => {
  it('only while the Setup page has started Setup', () => {
    expect(routesWebChatToSetupGuide({ ...EMPTY_SETUP_STATE, phase: 'in_progress' })).toBe(true);
    expect(routesWebChatToSetupGuide({ ...EMPTY_SETUP_STATE, phase: 'complete' })).toBe(false);
  });

  it('not on a database with no Setup row, such as a scripted test install', () => {
    expect(routesWebChatToSetupGuide(EMPTY_SETUP_STATE)).toBe(false);
  });
});
