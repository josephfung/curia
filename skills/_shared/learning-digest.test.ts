import { describe, it, expect } from 'vitest';
import { renderVoiceGuideSection, renderCompletionSection } from './learning-digest.js';
import type { CompletionDigestItem } from './learning-state.js';

const COMPLETION_ITEMS: CompletionDigestItem[] = [
  {
    kind: 'undo',
    taskId: 'aaa',
    taskTitle: 'Follow up with John',
    note: 'Marked *Follow up with John* done — you emailed john@example.com. Undo?',
  },
  {
    kind: 'confirm',
    taskId: 'bbb',
    taskTitle: 'Plan AGM',
    note: 'Did emailing board@example.com complete *Plan AGM*?',
  },
];

describe('learning digest renderers', () => {
  it('renders the guide section only when present', () => {
    expect(renderVoiceGuideSection(null)).toBe('');
    expect(renderVoiceGuideSection('- Writes short.')).toContain('### Proposed writing-voice update');
  });

  it('renders completion section only when items exist (snapshot)', () => {
    expect(renderCompletionSection([])).toBe('');
    expect(renderCompletionSection(COMPLETION_ITEMS)).toMatchInlineSnapshot(`
      "### Task completion from sent mail

      1. Marked *Follow up with John* done — you emailed john@example.com. Undo? Reply \`undo completion aaa\`.
      2. Did emailing board@example.com complete *Plan AGM*? Reply \`confirm completion bbb\` or \`dismiss completion bbb\`.
      "
    `);
  });
});
