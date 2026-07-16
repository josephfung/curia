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

export function parseVoiceGuideProposal(body: string): VoiceGuideProposal | null {
  const idx = body.indexOf('## Guide Proposal');
  if (idx < 0) return null;
  const section = body.slice(idx);
  const status = (section.match(/- status:\s*(\S+)/)?.[1] ?? 'pending').trim();
  if (status !== 'pending') return null;
  // Guide is everything after the blank line following the metadata, up to the trailing '---'.
  const afterMeta = section.replace(/^## Guide Proposal[\s\S]*?\n\n/, '');
  const guide = afterMeta.split(/\n---\s*$/m)[0]!.trim();
  return { status, guide };
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
  return body.replace(/(## Guide Proposal[\s\S]*?- status:\s*)\S+/, `$1${status}`);
}

export function markCompletionStatus(
  body: string,
  kind: 'Undo' | 'Confirm',
  taskId: string,
  status: string,
): string {
  const re = new RegExp(
    `(## ${kind} — task ${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?- status:\\s*)\\S+`,
  );
  return body.replace(re, `$1${status}`);
}
