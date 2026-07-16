// Shared parsers/renderers for voice proposals + task-completion digest sections (#1425).

export interface VoiceGuideProposal {
  status: string;
  guide: string;
}

export interface CompletionDigestItem {
  kind: 'undo' | 'confirm';
  taskId: string;
  taskTitle: string;
  note: string;
  status: string;
}

/** Split a pending-proposals body into its `## Guide Proposal` blocks. The doc is APPEND-ONLY
 *  (voice-learn appends a new block each cycle), so there can be several — an approved block
 *  followed by a fresh pending one is the steady state. The lookahead split keeps each header,
 *  so blocks re-join to the exact original bytes. Preamble (before the first block) is dropped. */
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
  const items: CompletionDigestItem[] = [];
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

export function markGuideProposalStatus(body: string, status: string): string {
  // Rewrite the status of the PENDING block only, leaving already-approved/dismissed blocks
  // intact (the append-only doc keeps prior blocks). If nothing is pending, return unchanged.
  const parts = body.split(/(?=^## Guide Proposal)/m);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.startsWith('## Guide Proposal')) continue;
    if (!/- status:\s*pending\b/.test(part)) continue;
    // The block's own status line is its first `- status:`; replace only that one.
    parts[i] = part.replace(/(- status:\s*)\S+/, `$1${status}`);
    break; // at most one pending block by construction
  }
  return parts.join('');
}

export function markCompletionStatus(
  body: string,
  kind: 'Undo' | 'Confirm',
  taskId: string,
  status: string,
): string {
  const esc = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the header EXACTLY: the task id must be followed by whitespace or end-of-line,
  // so id `t1` never matches a `t10` block. Scope the operation to a single block (split
  // on the `## ` boundary, delimiters preserved) so a later historical block for the same
  // task can't be picked instead of the current actionable one.
  const headerRe = new RegExp(`^## ${kind} — task ${esc}(?:\\s|$)`);
  // Only the actionable status is rewritten, so an already-resolved block (e.g. status
  // `undone`/`confirmed`/`dismissed`) is left untouched.
  const actionable = kind === 'Undo' ? 'undo_available' : 'pending_confirm';
  const statusRe = new RegExp(`(- status:\\s*)${actionable}\\b`);
  let done = false;
  return body
    .split(/(?=^## )/m)
    .map((block) => {
      if (done || !headerRe.test(block) || !statusRe.test(block)) return block;
      done = true;
      return block.replace(statusRe, `$1${status}`);
    })
    .join('');
}
