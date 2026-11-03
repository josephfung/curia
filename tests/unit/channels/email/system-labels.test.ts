import { describe, it, expect } from 'vitest';
import { isReadOnlySystemLabel, withoutReadOnlySystemLabels } from '../../../../src/channels/email/system-labels.js';

describe('isReadOnlySystemLabel', () => {
  it('matches SENT and DRAFT in any case and nothing else', () => {
    expect(['SENT', 'sent', 'DRAFT', 'Draft'].every(isReadOnlySystemLabel)).toBe(true);
    expect(['INBOX', 'Label_39', '✍️ Drafted'].some(isReadOnlySystemLabel)).toBe(false);
  });
});

describe('withoutReadOnlySystemLabels', () => {
  it('drops SENT and DRAFT in any case and keeps the rest in order', () => {
    expect(withoutReadOnlySystemLabels(['INBOX', 'SENT', 'Label_3', 'draft', 'STARRED']))
      .toEqual(['INBOX', 'Label_3', 'STARRED']);
  });

  it('returns an empty list when only read-only labels remain', () => {
    expect(withoutReadOnlySystemLabels(['SENT'])).toEqual([]);
  });
});
