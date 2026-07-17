// Shared renderers for voice proposals + task-completion digest sections (#1425).
// The markdown parsers/formatters that used to live here were retired once all callers
// migrated to config JSON (#1438); only the render* functions remain live.

// CompletionDigestItem now lives in learning-state.ts (#1438) since it's also the config-store
// map value type. renderCompletionSection reads only kind/taskId/note, all present there.
import type { CompletionDigestItem } from './learning-state.js';

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
