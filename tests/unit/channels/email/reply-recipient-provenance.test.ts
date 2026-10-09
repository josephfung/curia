import { describe, it, expect } from 'vitest';
import { replyDisplayName, replyRecipientSource } from '../../../../src/channels/email/reply-recipient-provenance.js';

const PASSING = [{ name: 'Authentication-Results', value: 'mx.google.com; spf=pass dkim=pass dmarc=pass' }];

describe('replyRecipientSource', () => {
  it('returns email_participant when auth passes and the address is not ours', () => {
    expect(replyRecipientSource({
      addressFromHeader: true,
      recipient: 'alice@example.com',
      selfEmails: ['curia@example.com'],
      headers: PASSING,
    })).toBe('email_participant');
  });

  it('returns undefined when headers are missing or auth failed', () => {
    expect(replyRecipientSource({
      addressFromHeader: true,
      recipient: 'alice@example.com',
      selfEmails: [],
    })).toBeUndefined();
    expect(replyRecipientSource({
      addressFromHeader: true,
      recipient: 'alice@example.com',
      selfEmails: [],
      headers: [{ name: 'Authentication-Results', value: 'mx; spf=fail dkim=pass dmarc=pass' }],
    })).toBeUndefined();
  });

  it('returns undefined for an owned mailbox, including case and plus-alias', () => {
    expect(replyRecipientSource({
      addressFromHeader: true,
      recipient: 'Curia+notes@example.com',
      selfEmails: ['curia@example.com'],
      headers: PASSING,
    })).toBeUndefined();
  });

  it('returns undefined when the address was not copied from a From header', () => {
    expect(replyRecipientSource({
      addressFromHeader: false,
      recipient: 'alice@example.com',
      selfEmails: [],
      headers: PASSING,
    })).toBeUndefined();
  });
});

describe('replyDisplayName', () => {
  it('returns a real name and drops a blank or the address itself', () => {
    expect(replyDisplayName('Alice', 'alice@example.com')).toBe('Alice');
    expect(replyDisplayName('  ', 'alice@example.com')).toBeUndefined();
    expect(replyDisplayName('Alice@example.com', 'alice@example.com')).toBeUndefined();
    expect(replyDisplayName(undefined, 'alice@example.com')).toBeUndefined();
  });
});
