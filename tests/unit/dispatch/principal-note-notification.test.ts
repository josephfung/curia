import { describe, it, expect } from 'vitest';
import { principalNoteBody } from '../../../src/dispatch/principal-note-notification.js';

const source = { senderLabel: 'Dana Whitfield', senderId: 'dana@vendor.example.test', channelId: 'email' };

describe('principal note notification', () => {
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
    const body = principalNoteBody('x', { ...source, senderLabel: `Dana\r\nBcc: attacker@example.test\u0000${'x'.repeat(200)}` });
    const line = body.split('\n').at(-1)!;
    expect(line).toContain('from Dana Bcc: attacker@example.test');
    expect(line).not.toMatch(/[\r\u0000]/);
    expect(line.length).toBeLessThan(200);
  });

  it('falls back to a generic label when the sender label is blank', () => {
    expect(principalNoteBody('x', { ...source, senderLabel: ' \n ' })).toContain('from the sender (dana@vendor.example.test)');
  });
});
