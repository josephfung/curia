import { describe, expect, it } from 'vitest';
import { isMessageSend } from '../../../src/agents/message-sends.js';

describe('isMessageSend (#2055)', () => {
  it.each(['email-send', 'email-reply', 'send-draft', 'signal-send', 'sms-send', 'slack-send'])(
    'counts %s',
    (tool) => {
      expect(isMessageSend(tool, { body: 'hi' })).toBe(true);
    },
  );

  it('does not count a saved draft or a read', () => {
    expect(isMessageSend('email-draft-save', { body: 'hi' })).toBe(false);
    expect(isMessageSend('email-list', {})).toBe(false);
    expect(isMessageSend('delegate', { agent: 'calendar', task: 'send it' })).toBe(false);
  });

  it('counts a created event only when it has guests', () => {
    expect(isMessageSend('calendar-create-event', { attendees: [{ email: 'jamie@stripe.com' }] })).toBe(true);
    expect(isMessageSend('calendar-create-event', { attendees: [] })).toBe(false);
    expect(isMessageSend('calendar-create-event', { title: 'Focus' })).toBe(false);
  });

  it('never counts a hold', () => {
    expect(isMessageSend('calendar-create-hold', { attendees: [{ email: 'jamie@stripe.com' }] })).toBe(false);
  });

  it('counts an update that changes guests or time, unless notifications are off', () => {
    expect(isMessageSend('calendar-update-event', { attendees: [{ email: 'a@b.co' }] })).toBe(true);
    expect(isMessageSend('calendar-update-event', { start: '2026-10-12T10:00:00-04:00' })).toBe(true);
    expect(isMessageSend('calendar-update-event', { start: '2026-10-12T10:00:00-04:00', notifyAttendees: false })).toBe(false);
    expect(isMessageSend('calendar-update-event', { title: 'Renamed' })).toBe(false);
  });

  it('counts a delete unless notifications are off', () => {
    expect(isMessageSend('calendar-delete-event', { eventId: 'e1' })).toBe(true);
    expect(isMessageSend('calendar-delete-event', { eventId: 'e1', notifyAttendees: false })).toBe(false);
  });

  it('counts an RSVP', () => {
    expect(isMessageSend('calendar-respond-to-invite', { response: 'accept' })).toBe(true);
  });

  it('tolerates a non-object input', () => {
    expect(isMessageSend('calendar-create-event', null)).toBe(false);
    expect(isMessageSend('email-send', 'oops')).toBe(true);
  });
});
