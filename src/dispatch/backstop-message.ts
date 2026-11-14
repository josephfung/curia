// backstop-message.ts — the text a held risky call returns to the model (#2588).
//
// It names what the other turn did (tool, target, local time) and nothing else: never the
// other turn's request text or any message body, which may belong to another conversation.
// Even those details go only to a viewer entitled to them (viewerSeesDetail); anyone else
// gets a generic line, so one person's turn cannot learn what another person's turn did.

import { toLocalIso } from '../time/timestamp.js';
import type { ActionOutcome, ActionTarget, BackstopDecision, RootTurn } from './turn-activity.js';

export type BackstopMatches = Extract<BackstopDecision, { held: true }>['matches'];
type BackstopMatch = BackstopMatches[number];

const HEADER = "Not run yet: another conversation's turn already acted on the same target.";
const FOOTER = "If your call still applies after this, call it again unchanged; if it would duplicate that work, don't.";
const GENERIC_LINE = '- Another conversation already acted on this same target recently.';
const NAME_MAX = 80;
/** What the other turn's call came to, as far as the registry knows. */
const OUTCOME_TEXT: Record<ActionOutcome, string> = {
  pending: 'is doing this right now',
  succeeded: 'already did this',
  unknown: 'tried this; the outcome is unknown',
};

/**
 * Whether the held root (`viewer`) may see the tool, target and time of `other`'s action:
 * the principal, a system turn (by originator, not channel), or the same resolved contact as
 * the other root. Unknown viewer: no.
 */
export function viewerSeesDetail(
  viewer: RootTurn | undefined,
  other: RootTurn,
  principalContactId: string | undefined,
): boolean {
  if (!viewer) return false;
  if (viewer.originatorIsSystem) return true;
  if (!viewer.originatorResolved || viewer.originatorContactId === null) return false;
  if (principalContactId !== undefined && viewer.originatorContactId === principalContactId) return true;
  return other.originatorResolved && other.originatorContactId === viewer.originatorContactId;
}

/** One line, bounded: a stored display name must not break out of its line. */
function singleLine(value: string, max: number): string {
  const flat = value
    // \s covers \r, \n and the Unicode line and paragraph separators.
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

function localTime(atMs: number, timezone: string): string {
  const iso = toLocalIso(Math.floor(atMs / 1000), timezone) ?? new Date(atMs).toISOString();
  // Whole seconds only: the milliseconds are noise in a prompt line.
  return iso.replace(/\.\d{3}(?=[+-]\d{2}:\d{2}$|Z$)/, '');
}

function targetDisplay(target: ActionTarget, contactName: (id: string) => string | undefined): string | null {
  switch (target.kind) {
    case 'contact': {
      const name = contactName(target.value);
      const shown = name === undefined ? '' : singleLine(name, NAME_MAX);
      return shown === '' ? 'a contact' : shown;
    }
    case 'site':
    case 'id':
      return target.value;
    case 'tool':
      // The tool itself is the target: the line already names it.
      return null;
  }
}

/**
 * `showDetail` decides per match whether the line names the tool, target and time; it
 * defaults to yes. Matches without detail share one generic line.
 */
export function renderBackstopHold(
  matches: BackstopMatches,
  opts: {
    timezone: string;
    contactName: (id: string) => string | undefined;
    showDetail?: (match: BackstopMatch) => boolean;
  },
): string {
  const lines = new Set<string>();
  for (const match of matches) {
    if (opts.showDetail && !opts.showDetail(match)) {
      lines.add(GENERIC_LINE);
      continue;
    }
    const shown = targetDisplay(match.target, opts.contactName);
    const on = shown === null ? '' : ` on ${shown}`;
    const state = OUTCOME_TEXT[match.action.outcome];
    lines.add(`- another conversation ${state}: ${match.action.toolName}${on} at ${localTime(match.action.at, opts.timezone)}`);
  }
  return [HEADER, ...lines, FOOTER].join('\n');
}
