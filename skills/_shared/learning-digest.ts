// Shared parsers/renderers for voice proposals + task-completion digest sections (#1425).

// CompletionDigestItem now lives in learning-state.ts (#1438) since it's also the config-store
// map value type. renderCompletionSection reads only kind/taskId/note, all present there.
import type { CompletionDigestItem } from './learning-state.js';

export interface VoiceGuideProposal {
  status: string;
  guide: string;
}

/** Split a pending-proposals body into its `## Guide Proposal` blocks. voice-learn appends a
 *  block each cycle, but resolved blocks are pruned on approve/dismiss (see pruneGuideProposals),
 *  so in steady state the doc holds at most the single pending block. The lookahead split keeps
 *  each header, so blocks re-join to the exact original bytes. */
function guideProposalBlocks(body: string): string[] {
  return body.split(/(?=^## Guide Proposal)/m).filter((b) => b.startsWith('## Guide Proposal'));
}

/** Extract the guide text from a single `## Guide Proposal` block. */
function guideFromBlock(block: string): string {
  // Guide is everything after the blank line following the metadata, up to the trailing '---'.
  const afterMeta = block.replace(/^## Guide Proposal[\s\S]*?\n\n/, '');
  return afterMeta.split(/\n---\s*$/m)[0]!.trim();
}

export function parseVoiceGuideProposal(body: string): VoiceGuideProposal | null {
  // Return the FIRST pending block (by construction there is at most one), scanning past any
  // earlier approved/dismissed blocks that the append-only doc has accumulated (F1).
  for (const block of guideProposalBlocks(body)) {
    const status = (block.match(/- status:\s*(\S+)/)?.[1] ?? 'pending').trim();
    if (status !== 'pending') continue;
    return { status, guide: guideFromBlock(block) };
  }
  return null;
}

export function parseCompletionDigest(body: string): CompletionDigestItem[] {
  // Local items carry `status` for the in-function filter logic below; the shared
  // CompletionDigestItem type (config-store map value) no longer has that field, so widen
  // the element type here rather than dropping the field parseCompletionDigest still needs.
  const items: Array<CompletionDigestItem & { status: string }> = [];
  for (const section of body.split(/^## /m).slice(1)) {
    const header = section.split('\n')[0] ?? '';
    const headerMatch = header.match(/^(Undo|Confirm) — task\s+(\S+)/);
    if (!headerMatch) continue;
    const kind = headerMatch[1] === 'Undo' ? 'undo' : 'confirm';
    const taskId = headerMatch[2]!;
    const status = (section.match(/- status:\s*(\S+)/)?.[1] ?? '').trim();
    if (kind === 'undo' && status !== 'undo_available') continue;
    if (kind === 'confirm' && status !== 'pending_confirm') continue;
    items.push({
      kind,
      taskId,
      taskTitle: (section.match(/- task_title:\s*(.+)/)?.[1] ?? '').trim(),
      note: (section.match(/- note:\s*(.+)/)?.[1] ?? '').trim(),
      status,
    });
  }
  return items;
}

/** Render digest sections — empty string when no items (omit section). */
export function renderVoiceGuideSection(guide: string | null): string {
  if (!guide) return '';
  return [
    '### Proposed writing-voice update',
    '',
    guide,
    '',
    'Reply `approve voice` or `dismiss voice`.',
    '',
  ].join('\n');
}

export function renderCompletionSection(items: CompletionDigestItem[]): string {
  if (items.length === 0) return '';
  const lines = [
    '### Task completion from sent mail',
    '',
    ...items.map((i, idx) => {
      if (i.kind === 'undo') {
        return `${idx + 1}. ${i.note} Reply \`undo completion ${i.taskId}\`.`;
      }
      return `${idx + 1}. ${i.note} Reply \`confirm completion ${i.taskId}\` or \`dismiss completion ${i.taskId}\`.`;
    }),
    '',
  ];
  return lines.join('\n');
}

/** Drop `## Guide Proposal` blocks from the append-only proposals doc so it can't grow without
 *  bound. By default removes only resolved (non-pending) blocks; pass `removePending` to also
 *  drop the pending one — used on approve/dismiss, since nothing reads a resolved proposal
 *  afterwards (the approved guide is written to the versioned ExecutiveProfile, which is the
 *  real audit trail, and the dismiss cooldown lives in config). The preamble/header before the
 *  first block is preserved. After resolving the sole pending block the doc is just its header,
 *  which voice-learn re-appends to next cycle. */
export function pruneGuideProposals(
  body: string,
  opts: { removePending?: boolean } = {},
): string {
  return body
    .split(/(?=^## Guide Proposal)/m)
    .filter((part) => {
      if (!part.startsWith('## Guide Proposal')) return true; // preamble / header
      const status = (part.match(/- status:\s*(\S+)/)?.[1] ?? 'pending').trim();
      return status === 'pending' && !opts.removePending;
    })
    .join('');
}

/** Remove a completion block from the append-only completion digest once its item has been
 *  actioned (undone/confirmed/dismissed), so resolved items don't accumulate. A block is dropped
 *  only when BOTH its header and its status line match: the task id must be followed by whitespace
 *  or end-of-line (so id `t1` never matches a `t10` block) AND the status must be the actionable
 *  one for that kind (`undo_available` for Undo, `pending_confirm` for Confirm/dismiss). Matching
 *  the status too means a historical block for the same task in a different state is preserved
 *  rather than removed in place of the live actionable one (which would leave the real item to be
 *  replayed after the task mutation already ran). Only the first matching block is dropped; other
 *  items and the preamble/header are preserved. */
export function removeCompletionBlock(
  body: string,
  kind: 'Undo' | 'Confirm',
  taskId: string,
): string {
  const esc = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^## ${kind} — task ${esc}(?:\\s|$)`);
  const expectedStatus = kind === 'Undo' ? 'undo_available' : 'pending_confirm';
  const statusRe = new RegExp(`^- status:\\s*${expectedStatus}\\b`, 'm');
  let removed = false;
  return body
    .split(/(?=^## )/m)
    .filter((block) => {
      if (removed || !headerRe.test(block) || !statusRe.test(block)) return true;
      removed = true;
      return false; // drop exactly one matching, actionable block
    })
    .join('');
}
