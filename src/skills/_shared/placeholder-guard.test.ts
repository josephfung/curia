import { describe, it, expect } from 'vitest';
import { isUnresolvedPlaceholder, unresolvedPlaceholderError } from './placeholder-guard.js';

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
