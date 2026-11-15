// backstop-message.ts — the text a held risky call returns to the model (#2588).
//
// It names what the other turn did (whose turn, tool, target, local time, and what came of
// it) and nothing else: never the other turn's request text or any message body, which may
// belong to another conversation. Even those details go only to a viewer entitled to them
// (viewerSeesDetail), and for a person's turn only to an authenticated sender in a one-to-one
// conversation; anyone else gets a generic line, so one person's turn cannot learn what
// another person's turn did, nor a forged sender what the person it claims to be did.

import type { ToolResult } from '../skills/types.js';
import { toLocalIso } from '../time/timestamp.js';
import { isAuthenticatedRoot, type ActionOutcome, type ActionTarget, type BackstopDecision, type RootTurn } from './turn-activity.js';

export type BackstopMatches = Extract<BackstopDecision, { held: true }>['matches'];
type BackstopMatch = BackstopMatches[number];

// "Another turn", not "another conversation": a root still running in the viewer's own
// conversation (a detached specialist of an earlier turn there) holds too.
const HEADER = 'Not run yet: another turn already acted on the same target.';
const FOOTER = "If your call still applies after this, call it again unchanged; if it would duplicate that work, don't.";
const GENERIC_LINE = '- Another turn already acted on this same target recently.';
const NAME_MAX = 80;
const CHANNEL_MAX = 32;
/** What the other turn's call came to, as far as the registry knows. */
const OUTCOME_TEXT: Record<ActionOutcome, string> = {
  pending: 'is doing this right now',
  succeeded: 'already did this',
  unknown: 'tried this; the outcome is unknown',
};

/**
 * Whether the held root (`viewer`) may see the tool, target and time of `other`'s action:
 * a system turn (by originator, not channel), or an authenticated sender (isAuthenticatedRoot:
 * web, CLI and SMS count) in a one-to-one conversation who is the principal or the same
 * resolved contact as the other root. In a group, a cc'd thread or an unknown audience the
 * model could repeat the details to the others there, so a person's turn gets the generic
 * line. An unauthenticated sender (a forged From resolves to whoever it names) gets it too.
 * Unknown viewer: no.
 */
export function viewerSeesDetail(
  viewer: RootTurn | undefined,
  other: RootTurn,
  principalContactId: string | undefined,
): boolean {
  if (!viewer) return false;
  if (viewer.originatorIsSystem) return true;
  if (!viewer.audienceOneToOne) return false;
  if (!isAuthenticatedRoot(viewer)) return false;
  if (!viewer.originatorResolved || viewer.originatorContactId === null) return false;
  if (principalContactId !== undefined && viewer.originatorContactId === principalContactId) return true;
  return sameResolvedContact(viewer, other);
}

/**
 * Both roots belong to the same resolved contact, and the other root's sender is
 * authenticated. An unauthenticated other root (a forged From names whom it likes) is a
 * different person here: it is never "your other conversation".
 */
function sameResolvedContact(viewer: RootTurn | undefined, other: RootTurn): boolean {
  return viewer !== undefined
    && viewer.originatorResolved
    && other.originatorResolved
    && viewer.originatorContactId !== null
    && viewer.originatorContactId === other.originatorContactId
    && isAuthenticatedRoot(other);
}

/**
 * The contact whose name a detail line shows as "a conversation with …": the other turn's
 * resolved person, when that is not the viewer and not Curia's own work. Null otherwise.
 */
export function otherTurnContactId(viewer: RootTurn | undefined, other: RootTurn): string | null {
  if (other.originatorIsSystem || !other.originatorResolved) return null;
  if (sameResolvedContact(viewer, other)) return null;
  return other.originatorContactId;
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

/**
 * A stored display name, single-lined, capped and JSON-quoted: it is untrusted data, and the
 * quotes keep it from reading as part of the sentence around it. Undefined when empty.
 */
function quotedName(name: string | undefined): string | undefined {
  const flat = name === undefined ? '' : singleLine(name, NAME_MAX);
  return flat === '' ? undefined : JSON.stringify(flat);
}

function localTime(atMs: number, timezone: string): string {
  const iso = toLocalIso(Math.floor(atMs / 1000), timezone) ?? new Date(atMs).toISOString();
  // Whole seconds only: the milliseconds are noise in a prompt line.
  return iso.replace(/\.\d{3}(?=[+-]\d{2}:\d{2}$|Z$)/, '');
}

function targetDisplay(target: ActionTarget, contactName: (id: string) => string | undefined): string | null {
  switch (target.kind) {
    case 'contact':
      return quotedName(contactName(target.value)) ?? 'a contact';
    case 'site':
    case 'id':
      return target.value;
    case 'tool':
      // The tool itself is the target: the line already names it.
      return null;
  }
}

/** Whose turn acted, from the viewer's side. */
function whoseTurn(
  viewer: RootTurn | undefined,
  other: RootTurn,
  contactName: (id: string) => string | undefined,
): string {
  if (other.originatorIsSystem) return 'a scheduled task';
  // From the viewer's own conversation only a root still running, or one that ended after the
  // viewer started, gets here (turn-activity.ts qualifyingOthers): e.g. an earlier turn's
  // detached specialist.
  const sameConversation = viewer !== undefined && viewer.conversationId === other.conversationId;
  if (sameResolvedContact(viewer, other)) {
    if (sameConversation) return 'your earlier turn in this conversation';
    const channel = singleLine(other.channelId, CHANNEL_MAX);
    return channel === '' ? 'your other conversation' : `your other conversation on ${channel}`;
  }
  const owner = otherTurnContactId(viewer, other);
  const name = quotedName(owner === null ? undefined : contactName(owner)) ?? 'another contact';
  return sameConversation ? `an earlier turn with ${name} in this conversation` : `a conversation with ${name}`;
}

/**
 * `showDetail` decides per match whether the line names whose turn it was, the tool, target,
 * time and outcome; it defaults to yes. Matches without detail share one generic line.
 * `viewer` is the held root, for "your other conversation" or "in this conversation".
 */
export function renderBackstopHold(
  matches: BackstopMatches,
  opts: {
    timezone: string;
    contactName: (id: string) => string | undefined;
    showDetail?: (match: BackstopMatch) => boolean;
    viewer?: RootTurn;
  },
): string {
  const lines = new Set<string>();
  for (const match of matches) {
    if (opts.showDetail && !opts.showDetail(match)) {
      lines.add(GENERIC_LINE);
      continue;
    }
    const whose = whoseTurn(opts.viewer, match.other, opts.contactName);
    const shown = targetDisplay(match.target, opts.contactName);
    const on = shown === null ? '' : ` on ${shown}`;
    const state = OUTCOME_TEXT[match.action.outcome];
    lines.add(`- ${whose} ${state}: ${match.action.toolName}${on} at ${localTime(match.action.at, opts.timezone)}`);
  }
  return [HEADER, ...lines, FOOTER].join('\n');
}

/** The hold text with no detail at all: the fallback when building the detailed one fails. */
export function renderGenericBackstopHold(): string {
  return [HEADER, GENERIC_LINE, FOOTER].join('\n');
}

/**
 * Held results, by identity. A hold returns `success: false` so the model re-issues rather
 * than assuming the work ran, but it is not a tool error: the runtime checks this before
 * counting a failure against the turn's consecutive-error budget. A marker set rather than a
 * field, so the public ToolResult type is unchanged.
 */
const crossTurnHolds = new WeakSet<object>();

export function markCrossTurnHold(result: ToolResult): ToolResult {
  crossTurnHolds.add(result);
  return result;
}

export function isCrossTurnHold(result: ToolResult): boolean {
  return crossTurnHolds.has(result);
}
