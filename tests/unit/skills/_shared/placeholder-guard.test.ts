import { describe, it, expect } from 'vitest';
import { isUnresolvedPlaceholder, unresolvedPlaceholderError, findTemplateTokens } from '../../../../src/skills/_shared/placeholder-guard.js';

describe('isUnresolvedPlaceholder', () => {
  it('matches a bare runtime token', () => {
    expect(isUnresolvedPlaceholder('${principal_contact_id}')).toBe(true);
    expect(isUnresolvedPlaceholder('${agent_contact_id}')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    // Models copying a token out of prose routinely bring a space with it.
    expect(isUnresolvedPlaceholder('  ${principal_contact_id} ')).toBe(true);
  });

  it('does not match a real value', () => {
    expect(isUnresolvedPlaceholder('deadbeef-0000-0000-0000-000000000001')).toBe(false);
    expect(isUnresolvedPlaceholder('system')).toBe(false);
    expect(isUnresolvedPlaceholder('')).toBe(false);
  });

  it('does not match text that merely contains a token', () => {
    // Anchored on purpose: a subject line or note quoting `${...}` is legitimate input,
    // and only a value that is *entirely* a token is the copied-from-a-description bug.
    expect(isUnresolvedPlaceholder('use ${principal_contact_id} here')).toBe(false);
  });

  it('does not match an empty or unclosed brace expression', () => {
    expect(isUnresolvedPlaceholder('${}')).toBe(false);
    expect(isUnresolvedPlaceholder('${unclosed')).toBe(false);
  });

  it('is false for non-strings', () => {
    expect(isUnresolvedPlaceholder(undefined)).toBe(false);
    expect(isUnresolvedPlaceholder(null)).toBe(false);
    expect(isUnresolvedPlaceholder(42)).toBe(false);
  });
});

describe('findTemplateTokens', () => {
  it('finds tokens embedded in prose', () => {
    expect(findTemplateTokens('pass ${principal_contact_id} to the skill'))
      .toEqual(['${principal_contact_id}']);
  });

  it('deduplicates, preserving first-seen order', () => {
    expect(findTemplateTokens('${b} then ${a} then ${b}')).toEqual(['${b}', '${a}']);
  });

  it('returns an empty array when there is nothing token-shaped', () => {
    expect(findTemplateTokens('a normal description')).toEqual([]);
    expect(findTemplateTokens('costs $50 for {approx} items')).toEqual([]);
  });

  it('agrees with isUnresolvedPlaceholder on what counts as a token', () => {
    // The two drifted once: this scan matched only `[a-z_]+` while the guard accepted any
    // token, so a name with a digit was rejected as an argument but invisible to the scan
    // meant to stop it being authored. Both now derive from one pattern.
    for (const token of ['${principal_contact_id}', '${principal_contact_id_2}', '${user2}', '${AGENT_ID}']) {
      expect(isUnresolvedPlaceholder(token), token).toBe(true);
      expect(findTemplateTokens(`see ${token} here`), token).toEqual([token]);
    }
  });

  it('does not match an empty brace expression', () => {
    expect(findTemplateTokens('${}')).toEqual([]);
  });
});

describe('unresolvedPlaceholderError', () => {
  it('names the field, echoes the token, and points at the real source', () => {
    const message = unresolvedPlaceholderError('contactId', '${principal_contact_id}');

    expect(message).toContain('contactId');
    expect(message).toContain('${principal_contact_id}');
    expect(message).toContain('system prompt');
  });

  it('trims the echoed token so the message stays clean', () => {
    expect(unresolvedPlaceholderError('contactId', '  ${principal_contact_id}  '))
      .toContain('token ${principal_contact_id} instead');
  });
});
