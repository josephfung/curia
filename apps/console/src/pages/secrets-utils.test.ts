import { describe, it, expect } from 'vitest';
import { declarerLabel, forceRemoveConfirmation } from './secrets-utils.js';

describe('secrets-utils', () => {
  it('labels declarers by kind', () => {
    expect(declarerLabel({ kind: 'tool', name: 'web-search', required: false, enabled: true })).toBe('Tool web-search');
    expect(declarerLabel({ kind: 'principal-mailbox', name: 'Calendar and principal inbox', required: true, enabled: true })).toBe('Calendar and principal inbox');
  });

  it('marks a disabled declarer so it reads as not needed yet', () => {
    expect(declarerLabel({ kind: 'channel', name: 'slack', required: true, enabled: false })).toBe('Channel slack (disabled)');
  });

  it('puts the server message in the force-remove confirmation', () => {
    expect(forceRemoveConfirmation("'k' is required by enabled tool 'x'.")).toBe("'k' is required by enabled tool 'x'.\n\nRemove it anyway?");
  });
});
