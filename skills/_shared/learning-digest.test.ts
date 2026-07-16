import { describe, it, expect } from 'vitest';
import {
  parseVoiceGuideProposal,
  parseCompletionDigest,
  renderVoiceGuideSection,
  renderCompletionSection,
  markGuideProposalStatus,
} from './learning-digest.js';

const GUIDE_DOC = `# Pending voice guide proposal\n\n## Guide Proposal\n- status: pending\n- generated_at: 2026-07-16T00:00:00.000Z\n\n- Writes short.\n- Dry humour.\n\n---\n`;

const COMPLETIONS = `
## Undo — task aaa
- status: undo_available
- task_title: Follow up with John
- note: Marked *Follow up with John* done — you emailed john@example.com. Undo?
---
## Confirm — task bbb
- status: pending_confirm
- task_title: Plan AGM
- note: Did emailing board@example.com complete *Plan AGM*?
---
## Undo — task ccc
- status: undone
- task_title: Old
- note: already handled
---
`;

describe('learning digest parsers + renderers', () => {
  it('parses a pending guide proposal', () => {
    expect(parseVoiceGuideProposal(GUIDE_DOC)?.guide).toContain('Dry humour');
  });

  it('returns null when no guide proposal is present or it is not pending', () => {
    expect(parseVoiceGuideProposal('')).toBeNull();
    expect(
      parseVoiceGuideProposal(
        `## Guide Proposal\n- status: approved\n- generated_at: x\n\n- Writes short.\n\n---\n`,
      ),
    ).toBeNull();
  });

  it('parses undo + confirm completion items; skips resolved', () => {
    const items = parseCompletionDigest(COMPLETIONS);
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe('undo');
    expect(items[1]!.kind).toBe('confirm');
  });

  it('renders the guide section only when present', () => {
    expect(renderVoiceGuideSection(null)).toBe('');
    expect(renderVoiceGuideSection('- Writes short.')).toContain('### Proposed writing-voice update');
  });

  it('renders completion section only when items exist (snapshot)', () => {
    expect(renderCompletionSection([])).toBe('');
    expect(renderCompletionSection(parseCompletionDigest(COMPLETIONS))).toMatchInlineSnapshot(`
      "### Task completion from sent mail

      1. Marked *Follow up with John* done — you emailed john@example.com. Undo? Reply \`undo completion aaa\`.
      2. Did emailing board@example.com complete *Plan AGM*? Reply \`confirm completion bbb\` or \`dismiss completion bbb\`.
      "
    `);
  });

  it('marks the guide proposal status', () => {
    expect(markGuideProposalStatus(GUIDE_DOC, 'approved')).toContain('status: approved');
  });
});
