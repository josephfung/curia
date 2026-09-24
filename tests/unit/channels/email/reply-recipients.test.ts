import { describe, it, expect } from 'vitest';
import { deriveEmailReplyRecipientSet } from '../../../../src/channels/email/reply-recipients.js';

describe('deriveEmailReplyRecipientSet', () => {
  const original = {
    originalFrom: 'alice@example.com',
    originalTo: [{ email: 'curia@example.com' }, { email: 'bob@example.com' }],
    originalCc: [{ email: 'carol@example.com' }],
    selfEmails: ['curia@example.com'],
  };

  it('returns null when originalFrom is missing', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      originalFrom: undefined,
      ccInput: undefined,
    })).toBeNull();
  });

  it('returns null when cc is a non-string (fail closed)', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: ['bob@example.com'],
    })).toBeNull();
  });

  it('reply-all (cc omitted) collects original To+CC minus sender and self', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: undefined,
    })).toEqual({
      to: 'alice@example.com',
      cc: ['bob@example.com', 'carol@example.com'],
    });
  });

  it('sender-only (cc === "") drops CC', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: '',
    })).toEqual({
      to: 'alice@example.com',
      cc: [],
    });
  });

  it('explicit CC list is parsed as-is', () => {
    expect(deriveEmailReplyRecipientSet({
      ...original,
      ccInput: 'a@example.com, b@example.com',
    })).toEqual({
      to: 'alice@example.com',
      cc: ['a@example.com', 'b@example.com'],
    });
  });

  it('reply-all dedupes case-insensitively and preserves first-seen order', () => {
    expect(deriveEmailReplyRecipientSet({
      originalFrom: 'alice@example.com',
      originalTo: [{ email: 'Bob@example.com' }, { email: 'bob@example.com' }],
      originalCc: [{ email: 'BOB@example.com' }, { email: 'carol@example.com' }],
      ccInput: undefined,
    })).toEqual({
      to: 'alice@example.com',
      cc: ['Bob@example.com', 'carol@example.com'],
    });
  });

  it('reply-all excludes every owned mailbox, not just the primary', () => {
    expect(deriveEmailReplyRecipientSet({
      originalFrom: 'alice@example.com',
      originalTo: [{ email: 'ops@example.com' }, { email: 'bob@example.com' }],
      originalCc: [{ email: 'curia@example.com' }],
      ccInput: undefined,
      selfEmails: ['curia@example.com', 'ops@example.com'],
    })).toEqual({
      to: 'alice@example.com',
      cc: ['bob@example.com'],
    });
  });
});
