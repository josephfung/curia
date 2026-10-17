// Stubbed sends refuse a typed address in a reference field, as the skill does (#2149).
import { describe, expect, it } from 'vitest';
import { recipientReferenceRefusal } from '../../shared/recipient-guard.js';
import { recipientReferenceShapeError } from '../../../src/skills/_shared/recipient-reference.js';

const CONTACT = '7a2e3f4b-5c6d-4e7f-8091-a2b3c4d5e6f7';

describe('recipientReferenceRefusal', () => {
  it('refuses any typed address in email-send `to`, with production\'s error', () => {
    for (const to of ['events@langdonhall.example', 'someone@else.example']) {
      expect(recipientReferenceRefusal('email-send', { to })).toBe(recipientReferenceShapeError(to, { field: 'to' }));
    }
    expect(recipientReferenceRefusal('email-send', { to: 'events@langdonhall.example' }))
      .toMatch(/^to takes a contact ID or "principal", not "events@langdonhall.example"\./);
  });

  it('accepts a contact ID, the principal alias, and a label hint', () => {
    expect(recipientReferenceRefusal('email-send', { to: CONTACT })).toBeUndefined();
    expect(recipientReferenceRefusal('email-send', { to: 'principal' })).toBeUndefined();
    expect(recipientReferenceRefusal('email-draft-save', { to: `${CONTACT}#work` })).toBeUndefined();
  });

  it('checks every entry of a comma-separated cc', () => {
    expect(recipientReferenceRefusal('email-send', { to: CONTACT, cc: `principal, ${CONTACT}` })).toBeUndefined();
    expect(recipientReferenceRefusal('email-send', { to: CONTACT, cc: 'principal, dana@newco.example' }))
      .toMatch(/^cc takes a contact ID/);
  });

  it('checks the recipient of signal, sms and slack sends', () => {
    for (const tool of ['signal-send', 'sms-send', 'slack-send']) {
      expect(recipientReferenceRefusal(tool, { recipient: '+15195550123' }), tool).toMatch(/^recipient takes a contact ID/);
      expect(recipientReferenceRefusal(tool, { recipient: CONTACT }), tool).toBeUndefined();
    }
  });

  it('leaves email-reply cc (addresses allowed), missing fields and other tools alone', () => {
    expect(recipientReferenceRefusal('email-reply', { cc: 'dana@newco.example' })).toBeUndefined();
    expect(recipientReferenceRefusal('email-send', {})).toBeUndefined();
    expect(recipientReferenceRefusal('email-send', { to: '' })).toBeUndefined();
    expect(recipientReferenceRefusal('web-fetch', { to: 'x@example.com' })).toBeUndefined();
  });
});
