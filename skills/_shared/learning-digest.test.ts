import { describe, it, expect } from 'vitest';
import {
  parseVoiceGuideProposal,
  parseCompletionDigest,
  renderVoiceGuideSection,
  renderCompletionSection,
  pruneGuideProposals,
  removeCompletionBlock,
} from './learning-digest.js';

const GUIDE_DOC = `# Pending voice guide proposal\n\n## Guide Proposal\n- status: pending\n- generated_at: 2026-07-16T00:00:00.000Z\n\n- Writes short.\n- Dry humour.\n\n---\n`;

// A doc that accumulated an approved block before a fresh pending one. Resolving now PRUNES
// resolved blocks (pruneGuideProposals), so this shape is transient/legacy — kept here to
// prove the parser skips resolved blocks and the pruner drops them.
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

  it('prunes resolved blocks by default, keeping the pending one', () => {
    const pruned = pruneGuideProposals(APPROVED_THEN_PENDING);
    // The approved block (and its guide) is gone; the pending block survives.
    expect(pruned).not.toContain('- Writes short.\n\n---\n\n## Guide Proposal');
    expect(pruned).toContain('- status: pending');
    expect((pruned.match(/## Guide Proposal/g) ?? []).length).toBe(1);
    expect(pruned).toContain('- Adds a dry closer.');
  });

  it('with removePending, drops every block (used on approve/dismiss so the queue does not grow)', () => {
    const pruned = pruneGuideProposals(APPROVED_THEN_PENDING, { removePending: true });
    expect(pruned).not.toContain('## Guide Proposal');
    expect(pruned).not.toContain('- status:');
    // Preamble/header is preserved so voice-learn can append to it next cycle.
    expect(pruned).toContain('# Pending voice guide proposal');
  });

  it('leaves an already header-only doc unchanged', () => {
    const headerOnly = '# Pending voice guide proposal\n\n';
    expect(pruneGuideProposals(headerOnly, { removePending: true })).toBe(headerOnly);
  });
});

describe('removeCompletionBlock', () => {
  const confirmBlock = (taskId: string, status: string) =>
    `\n## Confirm — task ${taskId}\n\n- status: ${status}\n- risk: low\n- task_title: T\n- sent_at: 2026-07-16\n\n---\n`;
  const undoBlock = (taskId: string, status: string) =>
    `\n## Undo — task ${taskId}\n\n- status: ${status}\n- task_title: T\n\n---\n`;

  it('does not let task id `t1` match a `t10` block (exact header only)', () => {
    const body = `# Digest\n${confirmBlock('t10', 'pending_confirm')}${confirmBlock('t1', 'pending_confirm')}`;
    const out = removeCompletionBlock(body, 'Confirm', 't1');
    // t1's block is removed; t10's survives.
    expect(out).not.toContain('## Confirm — task t1\n');
    expect(out).toContain('## Confirm — task t10\n');
  });

  it('removes exactly one matching block, preserving other items and the preamble', () => {
    const body = `# Digest\n${undoBlock('t5', 'undo_available')}${confirmBlock('t6', 'pending_confirm')}`;
    const out = removeCompletionBlock(body, 'Undo', 't5');
    expect(out).not.toContain('## Undo — task t5');
    expect(out).toContain('## Confirm — task t6'); // unrelated item untouched
    expect(out).toContain('# Digest'); // preamble kept
  });

  it('only removes a block of the matching kind', () => {
    const body = `# Digest\n${undoBlock('t7', 'undo_available')}`;
    // A Confirm action must not remove an Undo block.
    expect(removeCompletionBlock(body, 'Confirm', 't7')).toContain('## Undo — task t7');
    expect(removeCompletionBlock(body, 'Undo', 't7')).not.toContain('## Undo — task t7');
  });
});
