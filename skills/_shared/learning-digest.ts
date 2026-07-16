// Shared parsers/renderers for voice proposals + task-completion digest sections (#1425).

export interface VoiceProposalItem {
  field: string;
  description: string;
  sampleCount: number;
  consistency: string;
  patch: Record<string, unknown>;
  status: string;
}

export interface CompletionDigestItem {
  kind: 'undo' | 'confirm';
  taskId: string;
  taskTitle: string;
  note: string;
  status: string;
}

export function parseVoiceProposals(body: string): VoiceProposalItem[] {
  const items: VoiceProposalItem[] = [];
  for (const section of body.split(/^## Proposal — /m).slice(1)) {
    const field = (section.split('\n')[0] ?? '').trim();
    const status = (section.match(/- status:\s*(\S+)/)?.[1] ?? 'pending').trim();
    if (status !== 'pending') continue;
    let patch: Record<string, unknown> = {};
    const patchRaw = section.match(/- patch:\s*(\{[\s\S]*?\})\s*$/m)?.[1];
    if (patchRaw) {
      try {
        patch = JSON.parse(patchRaw) as Record<string, unknown>;
      } catch {
        patch = {};
      }
    }
    items.push({
      field,
      description: (section.match(/- description:\s*(.+)/)?.[1] ?? '').trim(),
      sampleCount: Number(section.match(/- sample_count:\s*(\d+)/)?.[1] ?? 0),
      consistency: (section.match(/- consistency:\s*(\S+)/)?.[1] ?? '').trim(),
      patch,
      status,
    });
  }
  return items;
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
export function renderVoiceProposalsSection(items: VoiceProposalItem[]): string {
  if (items.length === 0) return '';
  const lines = [
    '### Proposed voice diffs',
    '',
    ...items.map(
      (i, idx) =>
        `${idx + 1}. **${i.field}** — ${i.description} (n=${i.sampleCount}, consistency=${i.consistency}). Reply \`approve voice ${i.field}\` or \`dismiss voice ${i.field}\`.`,
    ),
    '',
  ];
  return lines.join('\n');
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

export function markProposalStatus(body: string, field: string, status: string): string {
  const re = new RegExp(
    `(## Proposal — ${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?- status:\\s*)pending`,
  );
  return body.replace(re, `$1${status}`);
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
