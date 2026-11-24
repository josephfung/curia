// priorities-doc.ts — the principal's priorities document (#2362).
//
// One `/shared/` document the coordinator pins (ADR-056), so it is in view every turn and the
// pin is also the coordinator's permission to write it. Superseded priorities move to the past
// document, which sits under `/meetings/` (durable, outside the `/shared/` guard).

export const PRIORITIES_PATH = '/shared/principal/priorities.md';
export const PRIORITIES_PAST_DEFAULT = '/meetings/principal/priorities-past.md';

/** Frontmatter a newly created priorities document starts with. `today` is a YYYY-MM-DD date. */
export function priorityFrontmatterDefaults(today: string): Record<string, unknown> {
  return {
    title: 'Priorities',
    as_of: today,
    past: PRIORITIES_PAST_DEFAULT,
    format:
      'Current priorities only, each a ## section with why it matters. Update as_of on every change. Move superseded ones to the document named in past:, never delete them.',
  };
}
