import { describe, it, expect } from 'vitest';
import { isOneToOneAudience } from '../../../src/dispatch/audience.js';

const SELF = ['curia@example.com'];

describe('isOneToOneAudience', () => {
  it('signal dm true, group false', () => {
    expect(isOneToOneAudience('signal', 'signal:+15551234567', undefined, SELF)).toBe(true);
    expect(isOneToOneAudience('signal', 'signal:group=abc', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('signal', 'other:+1555', undefined, SELF)).toBe(false);
  });

  it('slack dm true, channel false', () => {
    expect(isOneToOneAudience('slack', 'slack:D123', undefined, SELF)).toBe(true);
    expect(isOneToOneAudience('slack', 'slack:C123:1700000000.000100', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('slack', 'not-slack', undefined, SELF)).toBe(false);
  });

  it('sms true', () => {
    expect(isOneToOneAudience('sms', 'sms:+15551234567', undefined, SELF)).toBe(true);
  });

  it('email from principal to curia only is one-to-one', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [
        { email: 'Boss@Example.com', role: 'from' },
        { email: ' curia@example.com ', role: 'to' },
      ],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, SELF)).toBe(true);
  });

  it('email with a cc\'d third party is not', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [
        { email: 'boss@example.com', role: 'from' },
        { email: 'curia@example.com', role: 'to' },
        { email: 'other@example.com', role: 'cc' },
      ],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, SELF)).toBe(false);
  });

  it('email with only the sender (Curia BCC\'d) is not', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [{ email: 'boss@example.com', role: 'from' }],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, SELF)).toBe(false);
  });

  it('email with no selfEmails is not', () => {
    const metadata = {
      curiaRole: 'to',
      primaryRecipientEmails: [],
      participants: [
        { email: 'boss@example.com', role: 'from' },
        { email: 'curia@example.com', role: 'to' },
      ],
    };
    expect(isOneToOneAudience('email', 'email:t1', metadata, [])).toBe(false);
  });

  it('email with no participants is not', () => {
    expect(isOneToOneAudience('email', 'email:t1', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('email', 'email:t1', { participants: [] }, SELF)).toBe(false);
    expect(isOneToOneAudience('email', 'email:t1', { participants: [null, 'x', { role: 'to' }] }, SELF)).toBe(false);
  });

  it('unknown channel is not', () => {
    expect(isOneToOneAudience('voice', 'voice:1', undefined, SELF)).toBe(false);
    expect(isOneToOneAudience('http', 'http:1', undefined, SELF)).toBe(false);
  });
});
