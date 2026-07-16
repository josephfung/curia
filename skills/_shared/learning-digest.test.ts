import { describe, it, expect } from 'vitest';
import {
  parseVoiceGuideProposal,
  parseCompletionDigest,
  renderVoiceGuideSection,
  renderCompletionSection,
  markGuideProposalStatus,
} from './learning-digest.js';

const GUIDE_DOC = `# Pending voice guide proposal\n\n## Guide Proposal\n- status: pending\n- generated_at: 2026-07-16T00:00:00.000Z\n\n- Writes short.\n- Dry humour.\n\n---\n`;

// pending-proposals.md is APPEND-ONLY: voice-learn appends a new block each cycle, so after
// cycle 1 is approved the doc holds an approved block FOLLOWED BY a fresh pending block (F1).
const APPROVED_THEN_PENDING = `# Pending voice guide proposal\n\n## Guide Proposal\n- status: approved\n- generated_at: 2026-07-01T00:00:00.000Z\n\n- Writes short.\n\n---\n\n## Guide Proposal\n- status: pending\n- generated_at: 2026-07-16T00:00:00.000Z\n\n- Writes short.\n- Adds a dry closer.\n\n---\n`;

const ALL_RESOLVED = `# Pending voice guide proposal\n\n## Guide Proposal\n- status: approved\n- generated_at: 2026-07-01T00:00:00.000Z\n\n- Writes short.\n\n---\n\n## Guide Proposal\n- status: dismissed\n- generated_at: 2026-07-08T00:00:00.000Z\n\n- Rejected idea.\n\n---\n`;

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

  it('returns the PENDING block when an approved block precedes it (F1 append-only repro)', () => {
    const proposal = parseVoiceGuideProposal(APPROVED_THEN_PENDING);
    expect(proposal).not.toBeNull();
    expect(proposal!.status).toBe('pending');
    expect(proposal!.guide).toContain('Adds a dry closer');
    // The earlier approved block's guide must not leak into the returned proposal.
    expect(proposal!.guide).not.toContain('---');
  });

  it('returns null when every block is already approved/dismissed', () => {
    expect(parseVoiceGuideProposal(ALL_RESOLVED)).toBeNull();
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

  it('marks only the PENDING block, leaving an earlier approved block intact', () => {
    const marked = markGuideProposalStatus(APPROVED_THEN_PENDING, 'approved');
    // Both blocks now approved; none left pending.
    expect(marked).not.toContain('status: pending');
    expect((marked.match(/status: approved/g) ?? []).length).toBe(2);
    // The already-approved block's guide is preserved verbatim.
    expect(marked).toContain('- Adds a dry closer.');
  });

  it('returns the body unchanged when there is no pending block to mark', () => {
    expect(markGuideProposalStatus(ALL_RESOLVED, 'approved')).toBe(ALL_RESOLVED);
  });
});
