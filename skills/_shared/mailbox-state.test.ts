// mailbox-state.ts: which mailbox scope a per-mailbox learning record belongs to (#2475).
import { describe, it, expect } from 'vitest';
import { recordBelongsTo } from './mailbox-state.js';

describe('recordBelongsTo (R61)', () => {
  it('lets a deferred-fallback record belong to the migrated mailbox only', () => {
    expect(recordBelongsTo({ id: 'gmail', legacy: true }, 'mailbox')).toBe(true);
    expect(recordBelongsTo({ id: 'personal', legacy: false }, 'mailbox')).toBe(false);
    expect(recordBelongsTo({ id: 'gmail', legacy: true }, 'personal')).toBe(false);
    expect(recordBelongsTo({ id: 'gmail', legacy: true }, undefined)).toBe(true);
  });
});
