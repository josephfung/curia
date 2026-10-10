import { describe, it, expect } from 'vitest';
import { principalNoteBody, principalNoteSubject } from '../../../src/dispatch/principal-note-notification.js';

const source = { senderLabel: 'Dana Whitfield', senderId: 'dana@vendor.example.test', channelId: 'email' };

describe('principal note notification', () => {
  it('names the sender and channel in the subject', () => {
    expect(principalNoteSubject(source)).toBe("Note about Dana Whitfield's email");
    expect(principalNoteSubject({ ...source, channelId: 'signal' })).toBe("Note about Dana Whitfield's Signal message");
    expect(principalNoteSubject({ ...source, channelId: 'http' })).toBe("Note about Dana Whitfield's message");
  });

  it('puts the note first and says who the reply went to and that they did not see it', () => {
    const body = principalNoteBody('She asked whether the CFO will join.', source);
    expect(body.split('\n')[0]).toBe('She asked whether the CFO will join.');
    expect(body).toContain('Written while replying to an email from Dana Whitfield (dana@vendor.example.test). They were not sent this note.');
  });

  it('does not repeat the identifier when it is the label', () => {
    const body = principalNoteBody('x', { ...source, senderLabel: source.senderId, channelId: 'sms' });
    expect(body).toContain('a text from dana@vendor.example.test.');
  });

  it('folds a sender-controlled label onto one bounded line', () => {
    const subject = principalNoteSubject({ ...source, senderLabel: `Dana\r\nBcc: attacker@example.test\u0000${'x'.repeat(200)}` });
    expect(subject).not.toMatch(/[\r\n\u0000]/);
    expect(subject.startsWith('Note about Dana Bcc: attacker@example.test')).toBe(true);
    expect(subject.length).toBeLessThan(110);
  });

  it('falls back to a generic label when the sender label is blank', () => {
    expect(principalNoteSubject({ ...source, senderLabel: ' \n ' })).toBe("Note about a sender's email");
  });
});
