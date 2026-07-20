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

// ---------------------------------------------------------------------------
// Event-driven notification bodies (#1466)
//
// After #1464 removed the scheduled daily digest, these standalone builders let a generator
// surface a learning item the moment it's produced — the only path that now reaches the CEO for
// approve/dismiss/undo/confirm. They wrap the render* helpers above (which already inline both the
// reviewable content AND the reply commands) with a short preamble, so the CEO can act directly
// from the notification. The CEO's reply still resolves via resolve-learning-digest, unchanged.
// ---------------------------------------------------------------------------

/** Notification for a freshly-produced writing-voice guide proposal (voice-learn). */
export function buildVoiceProposalNotification(guide: string): { subject: string; body: string } {
  return {
    subject: 'Writing-voice guide update to review',
    body: [
      'I drafted an update to your writing-voice guide from your recent email edits.',
      '',
      // trimEnd drops the trailing blank line renderVoiceGuideSection appends for digest spacing.
      renderVoiceGuideSection(guide).trimEnd(),
    ].join('\n'),
  };
}

/** Notification for freshly-produced sent-mail task-completion items (task-completion-from-sent).
 *  `items` are this run's new undo/confirm entries — the caller must not pass an empty array
 *  (renderCompletionSection would omit the section, leaving a bare preamble). */
export function buildCompletionDigestNotification(
  items: CompletionDigestItem[],
): { subject: string; body: string } {
  const plural = items.length === 1 ? '' : 's';
  return {
    subject: `${items.length} task update${plural} from your sent mail`,
    body: [
      'I matched some of your sent mail to open tasks. Please review:',
      '',
      renderCompletionSection(items).trimEnd(),
    ].join('\n'),
  };
}
