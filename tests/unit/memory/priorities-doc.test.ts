// priorities-doc: the frontmatter defaults for the principal's priorities document (#2362).
import { describe, expect, it } from 'vitest';
import {
  PRIORITIES_PAST_DEFAULT,
  PRIORITIES_PATH,
  priorityFrontmatterDefaults,
} from '../../../src/memory/priorities-doc.js';
import { isDurableDocPath, isSharedDocPath } from '../../../src/memory/durable-doc-prefixes.js';

describe('priorities-doc', () => {
  it('lives under /shared/ and keeps its past document outside it', () => {
    expect(PRIORITIES_PATH).toBe('/shared/principal/priorities.md');
    expect(isSharedDocPath(PRIORITIES_PATH)).toBe(true);
    expect(PRIORITIES_PAST_DEFAULT).toBe('/meetings/principal/priorities-past.md');
    expect(isSharedDocPath(PRIORITIES_PAST_DEFAULT)).toBe(false);
    expect(isDurableDocPath(PRIORITIES_PAST_DEFAULT)).toBe(true);
  });

  it('builds the default frontmatter for a date', () => {
    expect(priorityFrontmatterDefaults('2026-11-23')).toEqual({
      title: 'Priorities',
      as_of: '2026-11-23',
      past: PRIORITIES_PAST_DEFAULT,
      format: 'Current priorities only, each a ## section with why it matters. Update as_of on every change. Move superseded ones to the document named in past:, never delete them.',
    });
  });
});
