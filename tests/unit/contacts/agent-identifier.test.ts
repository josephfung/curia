import { describe, it, expect } from 'vitest';
import { normalizeAgentIdentifier } from '../../../src/contacts/agent-identifier.js';

describe('normalizeAgentIdentifier', () => {
  it('lowercases and trims an email address', () => {
    expect(normalizeAgentIdentifier('email', '  Dana.Whitfield@NewCo.example ')).toEqual({
      ok: true,
      identifier: 'dana.whitfield@newco.example',
    });
  });

  it('refuses something that is not an email address, without echoing it', () => {
    const result = normalizeAgentIdentifier('email', 'dana at newco');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/email address/);
      expect(result.error).not.toContain('dana at newco');
    }
  });

  it.each(['phone', 'signal', 'sms'])('normalizes a %s number to E.164', (channel) => {
    expect(normalizeAgentIdentifier(channel, '(416) 555-0100')).toEqual({ ok: true, identifier: '+14165550100' });
    expect(normalizeAgentIdentifier(channel, '+44 20 7946 0958')).toEqual({ ok: true, identifier: '+442079460958' });
  });

  it('keeps a valid E.164 number the phone library does not recognise (Review Focus 4)', () => {
    // normalizePhone() returns null for the fictional 555 area code.
    expect(normalizeAgentIdentifier('sms', '+15555550199')).toEqual({ ok: true, identifier: '+15555550199' });
  });

  it('keeps a formatted valid E.164 number the phone library does not recognise, stored compact', () => {
    // normalizePhone() returns null for these; the fallback ignores formatting.
    expect(normalizeAgentIdentifier('sms', '+1 (555) 123-4567')).toEqual({ ok: true, identifier: '+15551234567' });
    expect(normalizeAgentIdentifier('sms', '+1 555 123 4567')).toEqual({ ok: true, identifier: '+15551234567' });
  });

  it('refuses an unrecognised number that has no leading +, even when formatted', () => {
    // normalizePhone() returns null here too, and without a + it is not E.164.
    const result = normalizeAgentIdentifier('sms', '555-123-4567');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/international form/);
  });

  it('refuses a value that is not a phone number', () => {
    const result = normalizeAgentIdentifier('sms', 'call me');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/international form/);
  });

  it('accepts Slack user ids (U… and W…) and refuses names and handles', () => {
    expect(normalizeAgentIdentifier('slack', 'U012ABCDEF')).toEqual({ ok: true, identifier: 'U012ABCDEF' });
    expect(normalizeAgentIdentifier('slack', 'W012ABCDEF')).toEqual({ ok: true, identifier: 'W012ABCDEF' });
    expect(normalizeAgentIdentifier('slack', '@pat').ok).toBe(false);
    expect(normalizeAgentIdentifier('slack', 'u012abcdef').ok).toBe(false);
  });

  it('passes other channels through trimmed, and refuses a blank value', () => {
    expect(normalizeAgentIdentifier('telegram', ' patp ')).toEqual({ ok: true, identifier: 'patp' });
    expect(normalizeAgentIdentifier('email', '   ').ok).toBe(false);
  });
});
