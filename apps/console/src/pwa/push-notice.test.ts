import { describe, expect, it } from 'vitest';
import { isNotice } from './push-notice.js';

describe('isNotice', () => {
  it('accepts every kind the server sends, so one paired notice cannot sink the config', () => {
    for (const kind of ['dead', 'setup', 'paired']) {
      expect(isNotice({ id: 'n-1', kind, detail: 'x', createdAt: '2026-11-02T12:00:00.000Z' })).toBe(true);
    }
    expect(isNotice({ id: 'n-1', kind: 'other', detail: 'x' })).toBe(false);
    expect(isNotice(null)).toBe(false);
  });
});
