import { describe, it, expect } from 'vitest';
import {
  parseEmailMetadata,
  sanitizeNylasMessageId,
  buildCcPreamble,
  buildThreadParticipantsBlock,
} from '../../../src/dispatch/email-metadata.js';
import type { EmailMetadata } from '../../../src/dispatch/email-metadata.js';

// ---------------------------------------------------------------------------
// parseEmailMetadata
// ---------------------------------------------------------------------------

describe('parseEmailMetadata', () => {
  it('extracts typed fields from a well-formed metadata object', () => {
    const meta = parseEmailMetadata({
      curiaRole: 'cc',
      primaryRecipientEmails: ['alice@example.com', 'bob@example.com'],
      nylasMessageId: 'msg-abc123',
      participants: [{ email: 'alice@example.com', role: 'from' }],
    });

    expect(meta.curiaRole).toBe('cc');
    expect(meta.primaryRecipientEmails).toEqual(['alice@example.com', 'bob@example.com']);
    expect(meta.nylasMessageId).toBe('msg-abc123');
    expect(meta.participants).toHaveLength(1);
  });

  it('returns safe defaults when metadata is undefined', () => {
    const meta = parseEmailMetadata(undefined);

    expect(meta.curiaRole).toBeUndefined();
    expect(meta.primaryRecipientEmails).toEqual([]);
    expect(meta.nylasMessageId).toBeUndefined();
    expect(meta.participants).toEqual([]);
  });

  it('returns undefined curiaRole when the field is not a string', () => {
    expect(parseEmailMetadata({ curiaRole: 42 }).curiaRole).toBeUndefined();
    expect(parseEmailMetadata({ curiaRole: null }).curiaRole).toBeUndefined();
    expect(parseEmailMetadata({ curiaRole: true }).curiaRole).toBeUndefined();
  });

  it('returns empty arrays when array fields are non-array types', () => {
    const meta = parseEmailMetadata({
      primaryRecipientEmails: 'not-an-array',
      participants: { email: 'foo@example.com' },
    });

    expect(meta.primaryRecipientEmails).toEqual([]);
    expect(meta.participants).toEqual([]);
  });

  it('passes nylasMessageId through as-is (unknown) for downstream sanitization', () => {
    expect(parseEmailMetadata({ nylasMessageId: 'msg-1' }).nylasMessageId).toBe('msg-1');
    expect(parseEmailMetadata({ nylasMessageId: undefined }).nylasMessageId).toBeUndefined();
    expect(parseEmailMetadata({ nylasMessageId: 42 }).nylasMessageId).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// sanitizeNylasMessageId
// ---------------------------------------------------------------------------

describe('sanitizeNylasMessageId', () => {
  it('returns ok with the value for a clean message ID', () => {
    expect(sanitizeNylasMessageId('msg-abc123')).toEqual({ ok: true, value: 'msg-abc123' });
  });

  it('strips prompt-injection characters and returns the sanitized value', () => {
    // Only \n \r [ ] < > are stripped; other characters survive
    const result = sanitizeNylasMessageId('msg-[<\n>]bar');
    expect(result).toEqual({ ok: true, value: 'msg-bar' });
  });

  it('truncates values longer than 200 characters', () => {
    const result = sanitizeNylasMessageId('x'.repeat(300));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(200);
  });

  it('returns empty-after-sanitize when raw collapses to empty after stripping', () => {
    // A value composed entirely of stripped characters
    const result = sanitizeNylasMessageId('\n\r[<>]');
    expect(result).toEqual({ ok: false, reason: 'empty-after-sanitize' });
  });

  it('returns absent-or-invalid for undefined', () => {
    expect(sanitizeNylasMessageId(undefined)).toEqual({ ok: false, reason: 'absent-or-invalid' });
  });

  it('returns absent-or-invalid for null', () => {
    expect(sanitizeNylasMessageId(null)).toEqual({ ok: false, reason: 'absent-or-invalid' });
  });

  it('returns absent-or-invalid for a non-string type', () => {
    expect(sanitizeNylasMessageId(42)).toEqual({ ok: false, reason: 'absent-or-invalid' });
    expect(sanitizeNylasMessageId({})).toEqual({ ok: false, reason: 'absent-or-invalid' });
  });

  it('returns absent-or-invalid for a whitespace-only string', () => {
    expect(sanitizeNylasMessageId('   ')).toEqual({ ok: false, reason: 'absent-or-invalid' });
    expect(sanitizeNylasMessageId('\n\t')).toEqual({ ok: false, reason: 'absent-or-invalid' });
  });
});

// ---------------------------------------------------------------------------
// buildCcPreamble
// ---------------------------------------------------------------------------

describe('buildCcPreamble', () => {
  // Minimal valid EmailMetadata for CC preamble tests
  function makeMeta(overrides: Partial<EmailMetadata> = {}): EmailMetadata {
    return {
      curiaRole: 'cc',
      primaryRecipientEmails: ['alice@example.com'],
      nylasMessageId: 'msg-abc123',
      participants: [],
      ...overrides,
    };
  }

  it('includes recipient list, Message ID, and Account when all present', () => {
    const result = buildCcPreamble(makeMeta(), 'curia', 'msg-abc123');

    expect(result).toContain('[OWNER CC — this email was addressed to alice@example.com');
    expect(result).toContain("you were CC'd, not the primary recipient]");
    expect(result).toContain('Message ID: msg-abc123');
    expect(result).toContain('Account: curia');
  });

  it('omits the Message ID line when nylasMessageId is undefined', () => {
    const result = buildCcPreamble(makeMeta(), 'curia', undefined);

    expect(result).not.toContain('Message ID:');
    expect(result).toContain('Account: curia');
  });

  it('falls back to "curia" when accountId is undefined', () => {
    const result = buildCcPreamble(makeMeta(), undefined, 'msg-abc123');

    expect(result).toContain('Account: curia');
  });

  it('shows "unknown recipients" when primaryRecipientEmails is empty', () => {
    const result = buildCcPreamble(makeMeta({ primaryRecipientEmails: [] }), 'curia', 'msg-abc123');

    expect(result).toContain('this email was addressed to unknown recipients');
  });

  it('sanitizes recipient addresses before interpolation', () => {
    const result = buildCcPreamble(
      makeMeta({ primaryRecipientEmails: ['evil[<\n>]injection@example.com'] }),
      'curia',
      'msg-abc123',
    );

    expect(result).toContain('evilinjection@example.com');
    expect(result).not.toContain('evil[<\n>]injection@example.com');
  });

  it('truncates to 10 recipients and shows +N more', () => {
    const recipients = Array.from({ length: 12 }, (_, i) => `user${i}@example.com`);
    const result = buildCcPreamble(makeMeta({ primaryRecipientEmails: recipients }), 'curia', 'msg-abc123');

    expect(result).toContain('+2 more');
  });

  it('shows plain "unknown recipients" when every address sanitizes to empty — no "+N more" suffix', () => {
    // Regression: previously produced "unknown recipients, +2 more" which is misleading
    const result = buildCcPreamble(
      makeMeta({ primaryRecipientEmails: ['\n\r', '\n\r\n'] }),
      'curia',
      'msg-abc123',
    );

    expect(result).toContain('unknown recipients');
    expect(result).not.toContain('+');
  });

  it('counts filtered-out (empty-after-sanitize) recipients in the omitted total', () => {
    // '\n\r' sanitizes to empty and should be counted as omitted
    const result = buildCcPreamble(
      makeMeta({ primaryRecipientEmails: ['\n\r', 'alice@example.com'] }),
      'curia',
      'msg-abc123',
    );

    expect(result).toContain('alice@example.com');
    expect(result).toContain('+1 more');
  });

  it('does not interpolate "null" when primaryRecipientEmails contains null elements', () => {
    // String(null) === "null" — ensure null elements are treated as empty, not the string "null"
    const meta = makeMeta({ primaryRecipientEmails: [null, 'alice@example.com'] });
    const result = buildCcPreamble(meta, 'curia', 'msg-abc123');

    expect(result).toContain('alice@example.com');
    expect(result).not.toContain('"null"');
    expect(result).not.toMatch(/\bnull\b/);
  });

  it('handles multiple valid recipients joined by commas', () => {
    const result = buildCcPreamble(
      makeMeta({ primaryRecipientEmails: ['alice@example.com', 'bob@example.com'] }),
      'curia',
      'msg-abc123',
    );

    expect(result).toContain('alice@example.com, bob@example.com');
  });
});

// ---------------------------------------------------------------------------
// buildThreadParticipantsBlock
// ---------------------------------------------------------------------------

describe('buildThreadParticipantsBlock', () => {
  // Minimal valid EmailMetadata for participants tests
  function makeMeta(participants: Array<{ email: unknown; role: unknown }>): EmailMetadata {
    return {
      curiaRole: undefined,
      primaryRecipientEmails: [],
      nylasMessageId: undefined,
      participants,
    };
  }

  it('returns a formatted participants line for a typical email', () => {
    const meta = makeMeta([
      { email: 'alice@example.com', role: 'from' },
      { email: 'curia@example.com', role: 'to' },
      { email: 'bob@example.com', role: 'cc' },
    ]);

    const result = buildThreadParticipantsBlock(meta, 'curia@example.com');

    expect(result).toContain('[Thread participants —');
    expect(result).toContain('From: alice@example.com');
    expect(result).toContain('To: you');
    expect(result).toContain('CC: bob@example.com');
  });

  it('returns null when the participants array is empty', () => {
    expect(buildThreadParticipantsBlock(makeMeta([]), undefined)).toBeNull();
  });

  it('returns null when all participants have null or empty-after-sanitize emails', () => {
    const meta = makeMeta([
      { email: null, role: 'from' },
      { email: '\n\r', role: 'to' },
    ]);

    expect(buildThreadParticipantsBlock(meta, undefined)).toBeNull();
  });

  it('handles null elements in the participants array without crashing', () => {
    // Nylas can return null elements during partial failures or schema drift
    const meta = {
      curiaRole: undefined,
      primaryRecipientEmails: [],
      nylasMessageId: undefined,
      participants: [null, { email: 'alice@example.com', role: 'from' }] as unknown[],
    };

    const result = buildThreadParticipantsBlock(meta, undefined);
    expect(result).toContain('From: alice@example.com');
  });

  it('handles non-object elements in the participants array without crashing', () => {
    const meta = {
      curiaRole: undefined,
      primaryRecipientEmails: [],
      nylasMessageId: undefined,
      participants: [42, 'bad-entry', { email: 'alice@example.com', role: 'from' }] as unknown[],
    };

    const result = buildThreadParticipantsBlock(meta, undefined);
    expect(result).toContain('From: alice@example.com');
  });

  it('returns null when all participants have unrecognized roles', () => {
    // Only 'from', 'to', 'cc' are bucketed — unknown roles are dropped
    const meta = makeMeta([{ email: 'alice@example.com', role: 'bcc' }]);

    expect(buildThreadParticipantsBlock(meta, undefined)).toBeNull();
  });

  it('sanitizes participant emails before interpolation', () => {
    const meta = makeMeta([{ email: 'evil[\n<inject>]@example.com', role: 'from' }]);

    const result = buildThreadParticipantsBlock(meta, undefined);

    expect(result).not.toBeNull();
    // The sanitized address should appear; the raw malicious form should not
    expect(result).toContain('evilinject@example.com');
    expect(result).not.toContain('evil[\n<inject>]@example.com');
  });

  it('caps at MAX_PARTICIPANTS (15) and ignores entries beyond the limit', () => {
    const participants = Array.from({ length: 20 }, (_, i) => ({
      email: `user${i}@example.com`,
      role: 'to',
    }));

    const result = buildThreadParticipantsBlock(makeMeta(participants), undefined);

    expect(result).not.toBeNull();
    expect(result).toContain('user14@example.com');
    expect(result).not.toContain('user15@example.com');
  });

  it('replaces selfEmail with "you" case-insensitively', () => {
    const meta = makeMeta([{ email: 'CURIA@EXAMPLE.COM', role: 'to' }]);

    const result = buildThreadParticipantsBlock(meta, 'curia@example.com');

    expect(result).toContain('To: you');
    expect(result).not.toContain('CURIA@EXAMPLE.COM');
  });

  it('does not replace selfEmail when selfEmail is undefined', () => {
    const meta = makeMeta([{ email: 'curia@example.com', role: 'to' }]);

    const result = buildThreadParticipantsBlock(meta, undefined);

    expect(result).toContain('To: curia@example.com');
  });

  it('omits buckets that are empty (only shows From/To/CC with entries)', () => {
    const meta = makeMeta([{ email: 'alice@example.com', role: 'from' }]);

    const result = buildThreadParticipantsBlock(meta, undefined);

    expect(result).toContain('From: alice@example.com');
    expect(result).not.toContain('To:');
    expect(result).not.toContain('CC:');
  });

  it('handles multiple addresses per role joined by commas', () => {
    const meta = makeMeta([
      { email: 'alice@example.com', role: 'from' },
      { email: 'bob@example.com', role: 'from' },
    ]);

    const result = buildThreadParticipantsBlock(meta, undefined);

    expect(result).toContain('From: alice@example.com, bob@example.com');
  });
});
