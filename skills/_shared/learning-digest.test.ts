import { describe, it, expect } from 'vitest';
import {
  renderVoiceGuideSection,
  renderCompletionSection,
  buildVoiceProposalNotification,
  buildCompletionDigestNotification,
} from './learning-digest.js';
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

      1. Marked *Follow up with John* done — you emailed john@example.com. Undo? Reply \`undo completion aaa\` or \`dismiss completion aaa\`.
      2. Did emailing board@example.com complete *Plan AGM*? Reply \`confirm completion bbb\` or \`dismiss completion bbb\`.
      "
    `);
  });
});

describe('numbered completion items (#2159 Phase 3)', () => {
  it('renders the stored number and number-based reply commands', () => {
    const items: CompletionDigestItem[] = [
      { ...COMPLETION_ITEMS[0]!, n: 1 },
      { ...COMPLETION_ITEMS[1]!, n: 2 },
    ];
    const out = renderCompletionSection(items);
    // "task N", not a bare number: approvals answer "approve 3" / "dismiss 3", and a learning item's
    // command must never be readable as one (review fix F3).
    expect(out).toContain('2. Did emailing board@example.com complete *Plan AGM*? Reply `confirm task 2` or `dismiss task 2`.');
    expect(out).toContain('1. Marked *Follow up with John* done — you emailed john@example.com. Undo? Reply `undo task 1` or `dismiss task 1`.');
    // The task id is no longer shown once an item has a number.
    expect(out).not.toContain('aaa');
    expect(out).not.toContain('bbb');
  });

  it('shows the item number, not the list position, when numbers are not contiguous', () => {
    const out = renderCompletionSection([{ ...COMPLETION_ITEMS[1]!, n: 7 }]);
    expect(out).toContain('7. Did emailing');
    expect(out).toContain('`confirm task 7`');
  });

  it('the notification body carries the number-based commands', () => {
    const { body } = buildCompletionDigestNotification([{ ...COMPLETION_ITEMS[0]!, n: 3 }]);
    expect(body).toContain('Reply `undo task 3` or `dismiss task 3`.');
  });
});

describe('event-driven learning notification bodies (#1466)', () => {
  it('voice proposal notification inlines the guide and the approve/dismiss reply commands', () => {
    const { subject, body } = buildVoiceProposalNotification('- Writes short.\n- Dry humour.');
    expect(subject).toBe('Writing-voice guide update to review');
    // The reviewable content is inlined verbatim...
    expect(body).toContain('- Writes short.');
    expect(body).toContain('- Dry humour.');
    // ...along with the section heading and the reply instructions the CEO acts on.
    expect(body).toContain('### Proposed writing-voice update');
    expect(body).toContain('Reply `approve voice` or `dismiss voice`.');
  });

  it('completion notification inlines each undo/confirm item with its reply commands and pluralizes the subject', () => {
    const { subject, body } = buildCompletionDigestNotification(COMPLETION_ITEMS);
    expect(subject).toBe('2 task updates from your sent mail');
    expect(body).toContain('### Task completion from sent mail');
    // Undo items offer leave-it-done as well as undo; confirm items are unchanged (#1936).
    expect(body).toContain('Reply `undo completion aaa` or `dismiss completion aaa`.');
    expect(body).toContain('Reply `confirm completion bbb` or `dismiss completion bbb`.');
  });

  it('completion notification subject is singular for one item', () => {
    const { subject } = buildCompletionDigestNotification([COMPLETION_ITEMS[0]!]);
    expect(subject).toBe('1 task update from your sent mail');
  });
});
