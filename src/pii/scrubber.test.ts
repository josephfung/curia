import { describe, it, expect } from 'vitest';
import { scrubPii, parseExtraPiiPatterns } from './scrubber.js';

describe('scrubPii — built-in patterns', () => {
  // ── Email ──────────────────────────────────────────────────────────────────

  it('scrubs a plain email address', () => {
    expect(scrubPii('Contact resolution failed for user@example.com')).not.toContain('user@example.com');
    expect(scrubPii('Contact resolution failed for user@example.com')).toContain('[EMAIL]');
  });

  it('scrubs email with subdomains and plus-addressing', () => {
    const result = scrubPii('Failed to send to john.doe+tag@mail.company.co.uk');
    expect(result).not.toContain('john.doe');
    expect(result).toContain('[EMAIL]');
  });

  it('scrubs multiple emails in one string', () => {
    const result = scrubPii('from alice@example.com to bob@other.org');
    expect(result).not.toContain('alice@example.com');
    expect(result).not.toContain('bob@other.org');
    expect(result.match(/\[EMAIL\]/g)?.length).toBe(2);
  });

  // ── Phone numbers ─────────────────────────────────────────────────────────

  it('scrubs a US phone in +1-NXX format', () => {
    expect(scrubPii('Phone lookup error for +1-555-867-5309')).toContain('[PHONE]');
  });

  it('scrubs a US phone in (NXX) NXX-XXXX format', () => {
    expect(scrubPii('Failed for (416) 555-1234')).toContain('[PHONE]');
  });

  it('scrubs a 10-digit US phone without formatting', () => {
    expect(scrubPii('Nylas error for sender at 5558675309')).toContain('[PHONE]');
  });

  // ── Credit card ───────────────────────────────────────────────────────────

  it('scrubs a credit card with spaces', () => {
    expect(scrubPii('Payment failed for card 4111 1111 1111 1111')).toContain('[CREDIT_CARD]');
  });

  it('scrubs a credit card without spaces', () => {
    expect(scrubPii('Payment failed for card 4111111111111111')).toContain('[CREDIT_CARD]');
  });

  it('scrubs a credit card with dashes', () => {
    expect(scrubPii('Card: 4111-1111-1111-1111')).toContain('[CREDIT_CARD]');
  });

  // ── SSN (keyword-prefixed only) ───────────────────────────────────────────

  it('scrubs SSN when preceded by "SSN:" keyword', () => {
    expect(scrubPii('SSN: 123-45-6789 is invalid')).toContain('[SSN]');
  });

  it('does NOT scrub bare 9-digit sequences without SSN keyword', () => {
    // Bare numbers (e.g. port numbers, order IDs) should not be scrubbed
    const result = scrubPii('order ref 123456789 processed');
    expect(result).toBe('order ref 123456789 processed');
  });

  // ── UUID protection ───────────────────────────────────────────────────────
  // UUIDs appear constantly in Curia logs (conversationId, contactId, taskId).
  // They must never be scrubbed as false-positive PII matches.

  it('does NOT scrub standard v4 UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(scrubPii(`taskId: ${uuid}`)).toContain(uuid);
  });

  it('does NOT scrub UUIDs with zero-heavy segments that look like credit cards', () => {
    const uuid = '00000000-0000-0000-0000-000000000001';
    expect(scrubPii(`taskId: ${uuid}`)).toContain(uuid);
  });

  it('does NOT scrub UUIDs with hex digit groups that look like phone numbers', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(scrubPii(`convId: ${uuid}`)).toContain(uuid);
  });

  it('scrubs PII in a string that also contains a UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const result = scrubPii(`taskId: ${uuid} failed for user@example.com`);
    expect(result).toContain(uuid);          // UUID preserved
    expect(result).toContain('[EMAIL]');     // email scrubbed
    expect(result).not.toContain('user@example.com');
  });

  // ── No-false-positive cases ───────────────────────────────────────────────

  it('does not alter plain log strings without PII', () => {
    const inputs = [
      'Dispatching to coordinator',
      'Skill timeout after 5000ms',
      'rate limited: 429 retry after 30s',
      'Error: ECONNREFUSED 127.0.0.1:5432',
      'Trust score: 0.85 for conversationId conv:xyz',
      'version 0.15.1 started',
    ];
    for (const input of inputs) {
      expect(scrubPii(input)).toBe(input);
    }
  });

  it('does not scrub ISO timestamps', () => {
    const ts = '2024-01-15T10:30:00.000Z';
    expect(scrubPii(`Failed to process message ${ts}`)).toContain(ts);
  });

  // ── Audit log contract ────────────────────────────────────────────────────
  // scrubPii is called on the LLM-facing copy only; the raw error is retained
  // in the audit log. This test verifies the scrubber doesn't mutate inputs.

  it('does not mutate the input string', () => {
    const original = 'error for user@example.com';
    const copy = original;
    scrubPii(original);
    expect(original).toBe(copy);
  });
});

describe('scrubPii — extra patterns', () => {
  it('applies operator-supplied extra patterns', () => {
    const extras = parseExtraPiiPatterns(
      [{ regex: 'EMP-\\d{6}', replacement: '[EMPLOYEE_ID]' }],
      'test',
    );
    const result = scrubPii('failed for employee EMP-123456 at step 3', extras);
    expect(result).not.toContain('EMP-123456');
    expect(result).toContain('[EMPLOYEE_ID]');
  });

  it('extra patterns are applied case-insensitively', () => {
    const extras = parseExtraPiiPatterns(
      [{ regex: 'passport-[a-z0-9]+', replacement: '[PASSPORT]' }],
      'test',
    );
    expect(scrubPii('doc PASSPORT-AB1234 failed', extras)).toContain('[PASSPORT]');
  });

  it('built-in patterns still apply when extras are provided', () => {
    const extras = parseExtraPiiPatterns(
      [{ regex: 'EMP-\\d{6}', replacement: '[EMPLOYEE_ID]' }],
      'test',
    );
    const result = scrubPii('EMP-999999 emailed user@example.com', extras);
    expect(result).toContain('[EMPLOYEE_ID]');
    expect(result).toContain('[EMAIL]');
  });
});

describe('parseExtraPiiPatterns — validation', () => {
  it('throws on missing regex field', () => {
    expect(() =>
      parseExtraPiiPatterns([{ regex: '', replacement: '[X]' }], 'test.yaml'),
    ).toThrow(/missing a valid 'regex'/);
  });

  it('throws on missing replacement field', () => {
    expect(() =>
      parseExtraPiiPatterns([{ regex: 'foo', replacement: '' }], 'test.yaml'),
    ).toThrow(/missing a valid 'replacement'/);
  });

  it('throws on invalid regex syntax', () => {
    expect(() =>
      parseExtraPiiPatterns([{ regex: '(unclosed', replacement: '[X]' }], 'test.yaml'),
    ).toThrow(/invalid regex/);
  });

  it('returns empty array for empty input', () => {
    expect(parseExtraPiiPatterns([], 'test.yaml')).toEqual([]);
  });
});

describe('classify.ts integration — PII scrubbing in error messages', () => {
  // These tests verify the full path: classify an error that contains PII
  // and confirm the LLM-facing message is scrubbed.

  it('scrubs email from classifyError message', async () => {
    // Dynamic import so setErrorPiiPatterns state is isolated from unit tests above
    const { classifyError } = await import('../errors/classify.js');
    const err = new Error('failed to contact user@example.com: timeout');
    const result = classifyError(err, 'nylas');
    expect(result.message).not.toContain('user@example.com');
    expect(result.message).toContain('[EMAIL]');
  });

  it('scrubs phone from classifySkillError message', async () => {
    const { classifySkillError } = await import('../errors/classify.js');
    const result = classifySkillError('signal-send', 'recipient +1-555-867-5309 not found');
    expect(result.message).not.toContain('+1-555-867-5309');
    expect(result.message).toContain('[PHONE]');
  });

  it('scrubs credit card from classifySkillError message', async () => {
    const { classifySkillError } = await import('../errors/classify.js');
    const result = classifySkillError('payment', 'card 4111 1111 1111 1111 declined');
    expect(result.message).not.toContain('4111 1111 1111 1111');
    expect(result.message).toContain('[CREDIT_CARD]');
  });
});
