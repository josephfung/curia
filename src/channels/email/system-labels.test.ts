import { describe, it, expect } from 'vitest';
import { withoutReadOnlySystemLabels } from './system-labels.js';

describe('withoutReadOnlySystemLabels', () => {
  it('drops SENT and DRAFT in any case and keeps the rest in order', () => {
    expect(withoutReadOnlySystemLabels(['INBOX', 'SENT', 'Label_3', 'draft', 'STARRED']))
      .toEqual(['INBOX', 'Label_3', 'STARRED']);
  });

  it('returns an empty list when only read-only labels remain', () => {
    expect(withoutReadOnlySystemLabels(['SENT'])).toEqual([]);
  });
});
