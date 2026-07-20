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

      1. Marked *Follow up with John* done — you emailed john@example.com. Undo? Reply \`undo completion aaa\`.
      2. Did emailing board@example.com complete *Plan AGM*? Reply \`confirm completion bbb\` or \`dismiss completion bbb\`.
      "
    `);
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
    // undo item carries its `undo completion <id>` command; confirm item carries confirm/dismiss.
    expect(body).toContain('Reply `undo completion aaa`.');
    expect(body).toContain('Reply `confirm completion bbb` or `dismiss completion bbb`.');
  });

  it('completion notification subject is singular for one item', () => {
    const { subject } = buildCompletionDigestNotification([COMPLETION_ITEMS[0]!]);
    expect(subject).toBe('1 task update from your sent mail');
  });
});
