import { describe, expect, it } from 'vitest';
import { editableBy, isConsoleOnlyMarked } from '../../../src/memory/console-only-docs.js';

describe('console-only documents (editable_by)', () => {
  it('reads the key case-insensitively and returns its raw value', () => {
    expect(editableBy({ editable_by: 'console' })).toBe('console');
    expect(editableBy({ Editable_By: 'anyone' })).toBe('anyone');
    expect(editableBy({ title: 'x' })).toBeUndefined();
    expect(editableBy(null)).toBeUndefined();
    expect(editableBy(undefined)).toBeUndefined();
  });

  it('marks only the console value, compared trimmed and case-insensitively', () => {
    expect(isConsoleOnlyMarked({ editable_by: 'console' })).toBe(true);
    expect(isConsoleOnlyMarked({ EDITABLE_BY: ' Console ' })).toBe(true);
    expect(isConsoleOnlyMarked({ editable_by: 'anyone' })).toBe(false);
    expect(isConsoleOnlyMarked({ editable_by: true })).toBe(false);
    expect(isConsoleOnlyMarked({})).toBe(false);
  });
});
