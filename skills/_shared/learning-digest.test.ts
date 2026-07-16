import { describe, it, expect } from 'vitest';
import {
  parseVoiceProposals,
  parseCompletionDigest,
  renderVoiceProposalsSection,
  renderCompletionSection,
} from './learning-digest.js';

const PROPOSALS = `
## Proposal — signOff
- status: pending
- description: Prefer sign-off "Thanks"
- sample_count: 3
- consistency: 1.00
- magnitude: low
- patch: {"sign_off":"Thanks"}
---
## Proposal — formality
- status: approved
- description: shift
- sample_count: 8
- consistency: 1.00
- patch: {"formality_delta":-10}
---
`;

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
  it('parses pending voice proposals only', () => {
    const items = parseVoiceProposals(PROPOSALS);
    expect(items).toHaveLength(1);
    expect(items[0]!.field).toBe('signOff');
    expect(items[0]!.patch).toEqual({ sign_off: 'Thanks' });
  });

  it('parses undo + confirm completion items; skips resolved', () => {
    const items = parseCompletionDigest(COMPLETIONS);
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe('undo');
    expect(items[1]!.kind).toBe('confirm');
  });

  it('renders voice section only when items exist (snapshot)', () => {
    expect(renderVoiceProposalsSection([])).toBe('');
    expect(renderVoiceProposalsSection(parseVoiceProposals(PROPOSALS))).toMatchInlineSnapshot(`
      "### Proposed voice diffs

      1. **signOff** — Prefer sign-off "Thanks" (n=3, consistency=1.00). Reply \`approve voice signOff\` or \`dismiss voice signOff\`.
      "
    `);
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
});
