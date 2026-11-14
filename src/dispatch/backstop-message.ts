// backstop-message.ts — the text a held risky call returns to the model (#2588).
//
// It names what the other turn did (tool, target, local time) and nothing else: never the
// other turn's request text or any message body, which may belong to another conversation.

import { toLocalIso } from '../time/timestamp.js';
import type { ActionTarget, BackstopDecision } from './turn-activity.js';

export type BackstopMatches = Extract<BackstopDecision, { held: true }>['matches'];

const HEADER = "Not run yet: another conversation's turn already acted on the same target.";
const FOOTER = "If your call still applies after this, call it again unchanged; if it would duplicate that work, don't.";
const NAME_MAX = 80;

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

export function renderBackstopHold(
  matches: BackstopMatches,
  opts: { timezone: string; contactName: (id: string) => string | undefined },
): string {
  const lines = matches.map(({ action, target }) => {
    const shown = targetDisplay(target, opts.contactName);
    const on = shown === null ? '' : ` on ${shown}`;
    return `- ${action.toolName}${on} at ${localTime(action.at, opts.timezone)}`;
  });
  return [HEADER, ...lines, FOOTER].join('\n');
}
