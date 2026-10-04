// Principal-facing reply when a delegation cannot continue (#1860).
//
// The model writes it, with the failed request in context, so two asks do not
// produce the same sentence. A deterministic fallback remains for the
// model-unavailable path and for any draft that fails a structural check.
//
// Nothing written for another audience is quoted to the principal (#1975, #1976).
// The delegate brief addresses the specialist and can carry contact ids and "the
// principal". The specialist's decline prose addresses the coordinator and names
// tools, grants and secrets. Neither reaches the model's prompt or the fallback.
//
// The reply speaks for Curia as one assistant and does not name the specialist
// (#1975). Which agent the work was handed to is internal; the principal asked
// Curia, and "the calendar specialist declined" reads as a peek behind the
// curtain. The display name is still passed in, so a draft that names the
// specialist anyway can be caught.
//
// The reader is not always the principal (#1978). On an inbound from anyone else
// (an external email, an unresolved sender) the dispatcher relays this reply to
// that sender. Those turns get a prompt that names the sender as the reader, and a
// fallback that promises to follow up rather than reporting the internal follow-up
// task, which is a note for the principal. The promise is made only when that task
// was logged, because on these turns it records the sender as waiting on a reply.
//
// A sender's reply has a second block for the principal (#1990). Told only "add no
// note for the principal", the model wrote one anyway, addressed by name, inside the
// reply: it had something real to tell the principal and one place to write it. So
// the sender prompt asks for anything meant for the principal in a
// <note_for_principal> block, which is cut out of the text before the reply is read
// and returned separately for the runtime to record.

import type { TaskOriginator } from '../contacts/types.js';
import type { Message } from './llm/provider.js';
import { SPECIALIST_DECLINE_REASON } from './specialist-decline.js';
import { containsRawAgentId } from './agent-display-name.js';
import { UUID_PATTERN } from '../util/uuid.js';
import { escapeRegExp } from '../util/escape-regexp.js';
import { sanitizeOutput } from '../skills/sanitize.js';

/**
 * Who reads the reply. `principal` is the principal (or an agent acting for them).
 * `sender` is the person whose inbound started this turn when they are not the
 * principal: the dispatcher relays the reply to them, so it must be written to them.
 */
export type ReplyAudience = 'principal' | 'sender';

// Channels whose tasks are never answered to an outside sender: the scheduler,
// Bullpen threads, and internal hand-offs (including the voice off-ramp, which keeps
// the principal-facing reply it had before #1978).
const NON_SENDER_CHANNELS: ReadonlySet<string> = new Set(['scheduler', 'bullpen', 'internal']);

// Channels only the principal can reach. The contact resolver always resolves them
// to the principal (src/contacts/contact-resolver.ts): local console sessions and the
// bootstrap-secret web app.
const PRINCIPAL_ONLY_CHANNELS: ReadonlySet<string> = new Set(['cli', 'smoke-test', 'web']);

/** Why delegationFailureAudience chose its reader. Logged with the reply. */
export type ReplyAudienceBasis =
  | 'delegated'
  | 'non_sender_channel'
  | 'principal_only_channel'
  | 'principal_side_originator'
  | 'non_principal_originator'
  | 'originator_missing';

// Roles whose turns are read on the principal's side: the principal, and work the
// platform or Curia started (scheduled jobs, self-initiated tasks).
const PRINCIPAL_SIDE_ROLES: ReadonlySet<string> = new Set(['principal', 'system', 'agent']);

/**
 * The reader of this turn's delegation-failure reply.
 *
 * A delegated specialist answers the agent that delegated to it, the system
 * channels never answer an outside sender, and the principal-only channels are
 * read by the principal whatever the originator says. On any other channel the reply goes back
 * to whoever is on that thread, so the principal is the reader only when the
 * originator says so. Everything else is read as an outside sender: a null role
 * (the dispatcher's stamp for anyone not the principal, unresolved senders
 * included, #1059), an unrecognised role, and a missing originator. Some
 * dispatcher-relayed tasks carry none, such as the content-block rewrite retry.
 * Erring this way costs the principal a plainer reply. Erring the other way
 * sends an outside sender a note meant for the principal.
 */
export function delegationFailureAudience(turn: {
  originator: TaskOriginator | undefined;
  channelId: string;
  delegated: boolean;
}): { audience: ReplyAudience; basis: ReplyAudienceBasis } {
  if (turn.delegated) return { audience: 'principal', basis: 'delegated' };
  if (NON_SENDER_CHANNELS.has(turn.channelId)) return { audience: 'principal', basis: 'non_sender_channel' };
  if (PRINCIPAL_ONLY_CHANNELS.has(turn.channelId)) return { audience: 'principal', basis: 'principal_only_channel' };
  if (turn.originator === undefined) return { audience: 'sender', basis: 'originator_missing' };
  const role = turn.originator.systemRole;
  return typeof role === 'string' && PRINCIPAL_SIDE_ROLES.has(role)
    ? { audience: 'principal', basis: 'principal_side_originator' }
    : { audience: 'sender', basis: 'non_principal_originator' };
}

export interface DelegationFailureReplyInput {
  /** Who reads the reply. Decides the prompt's reader and the fallback's follow-up line. */
  audience: ReplyAudience;
  /** The specialist's principal-facing label. Never written into the reply; a draft containing it is rejected. */
  displayName: string;
  agentId: string;
  reason: string;
  declined?: boolean;
  possiblySucceeded?: boolean;
  escalated: boolean;
  /**
   * The turn's own request: the text the narration model sees as the user turn.
   * Used only to check that a draft is about this request. Never quoted, because
   * it is not always the principal's words (scheduler payloads, channel preambles).
   */
  request: string;
  /** Raw model output. Absent when the narration call did not return text. */
  modelText?: string;
}

/** Why a model draft was not used. Logged, so a rising fallback rate can be traced. */
export type DraftRejection =
  | 'empty'
  | 'no_reply_block'
  | 'agent_id'
  | 'names_specialist'
  | 'protocol'
  | 'prompt_echo'
  | 'uuid'
  | 'internal_note'
  | 'lost_thread'
  | 'unbacked_promise'
  | 'off_topic'
  // A sender reply still holding a <note_for_principal> tag after complete note blocks
  // were cut out: an unclosed note, or a stray closing tag (#1990).
  | 'note_markup';

// The instruction lines of the narration prompt. Kept apart from the situation lines
// (what failed, whether a follow-up was logged) because a good reply restates those
// facts, while it never has a reason to repeat an instruction. The echo check runs
// against these lines only. The situation lines avoid "specialist" and "delegated"
// so the model is not handed the words it is told not to use.
//
// The opening names the reader, which depends on the audience (#1978), and so does
// the line on what to say about the request. The principal hears what you were
// trying to do. A sender hears only about what they asked for: what you were
// trying to do is often "find our earlier thread", and saying so to them is the
// #1978 disclosure. A sender also gets a line keeping internal records out of the
// reply, and a separate block for anything meant for the principal (#1990).
const NARRATION_OPENING: Record<ReplyAudience, string> = {
  principal: 'Something you were doing for the principal failed. Write the one message they will read.',
  sender: 'Something you were doing in reply to the person who sent this message failed. '
    + 'They are not the principal. Write the one message they will read.',
};
const NARRATION_SHARED = [
  'Address them directly as "you", and speak for yourself as "I".',
  'Do not mention specialists, other agents, or handing the work off.',
  'Do not use internal agent ids, tool names, IDs, or protocol markers.',
] as const;
const NARRATION_REQUEST_LINE: Record<ReplyAudience, string> = {
  principal: 'Say briefly, in your own words, what you were trying to do for them.',
  sender: 'Speak only to what they asked for. Do not describe what you looked for, '
    + 'could not find, or have no record of.',
};
const NARRATION_FRESH = 'Write it as a fresh sentence about this request. Do not reuse a stock line.';
const NARRATION_SENDER_ONLY = 'Write only to them, and say nothing about tasks, records or reviews kept on your side.';
// The closing format line. For a sender it also carries the redirect (#1990): "do not
// write a note" alone did not hold, so the model is given a place to put what the
// principal should hear. Both blocks are laid out in one line, in order. Probed on the
// production standard-tier model, a separate note line mid-prompt had a third of drafts
// come back with no usable reply block (often a bare closing tag); this layout matched
// the reply-block rate of the principal-only format.
const NARRATION_FORMAT: Record<ReplyAudience, string> = {
  principal: 'Do not call tools. Put only the message inside <reply></reply> tags.',
  sender: 'Do not call tools. Write the message to them inside <reply></reply> tags. '
    + 'If there is something the principal should know, add it after the reply inside '
    + '<note_for_principal></note_for_principal> tags. '
    + 'Only the principal sees that note; nothing for the principal goes in the reply.',
};

function narrationInstructions(audience: ReplyAudience): string[] {
  return [
    NARRATION_OPENING[audience],
    ...NARRATION_SHARED,
    NARRATION_REQUEST_LINE[audience],
    NARRATION_FRESH,
    ...(audience === 'sender' ? [NARRATION_SENDER_ONLY] : []),
  ];
}

// Every instruction line, for either audience. The echo and topic checks run on all
// of them: a draft quoting the principal opening is an echo whoever it was for.
const ALL_NARRATION_INSTRUCTIONS: readonly string[] = [
  ...Object.values(NARRATION_OPENING),
  ...NARRATION_SHARED,
  ...Object.values(NARRATION_REQUEST_LINE),
  NARRATION_FRESH,
  NARRATION_SENDER_ONLY,
  ...Object.values(NARRATION_FORMAT),
];

// Every situation and follow-up line the prompt can carry. Listed in one place so
// the topic check can discount their words (see PROMPT_VOCABULARY).
const SITUATION = {
  timeout: 'It did not get done in time.',
  timeoutMaybeDone: 'It did not get done in time. The work may still be finishing in the background.',
  blocked: 'It was blocked and could not be finished.',
  declined: 'It was turned down and will not be done as asked.',
  other: 'It could not be finished.',
  escalated: 'A follow-up task has already been logged.',
  notEscalated: 'A follow-up task could not be logged.',
  // For a sender, the logged task is the principal's business. What they can be told
  // is whether someone will come back to them, which is true only when the task was
  // logged: it records them as waiting on a reply (#1978).
  escalatedForSender: 'Someone will come back to it, so you may say you will follow up.',
  notEscalatedForSender: 'Do not promise to follow up or say when they will hear back.',
} as const;

export function delegationFailureNarrationPrompt(input: {
  audience: ReplyAudience;
  reason: string;
  possiblySucceeded?: boolean;
  escalated: boolean;
  declined?: boolean;
}): string {
  const situation = describeFailure(input.reason, input.declined, input.possiblySucceeded);
  const followUp = input.audience === 'sender'
    ? (input.escalated ? SITUATION.escalatedForSender : SITUATION.notEscalatedForSender)
    : (input.escalated ? SITUATION.escalated : SITUATION.notEscalated);
  // The situation sits just before the closing format line.
  return [...narrationInstructions(input.audience), situation, followUp, NARRATION_FORMAT[input.audience]].join('\n');
}

function describeFailure(reason: string, declined: boolean | undefined, possiblySucceeded: boolean | undefined): string {
  if (reason === 'timeout') return possiblySucceeded ? SITUATION.timeoutMaybeDone : SITUATION.timeout;
  if (reason === 'blocked') return SITUATION.blocked;
  if (declined === true || reason === SPECIALIST_DECLINE_REASON) return SITUATION.declined;
  return SITUATION.other;
}

/**
 * Deterministic reply, in the first person. It states the kind of failure and
 * deliberately says nothing about the request or the specialist: the only
 * request text on hand is the brief (written for the specialist) or the turn
 * content (which may be a scheduler payload or carry a channel preamble).
 * Quoting either is how #1975 leaked. The model path is what names the request.
 *
 * For an outside sender the escalation line is a promise to follow up, not a
 * report of the internal task, which is the principal's to know (#1978). The
 * promise is kept honest by the task itself: on a sender's turn it records them as
 * waiting on a reply, so the principal's digest shows it. With no task logged,
 * nothing is promised.
 */
export function formatDelegationFailureFallback(
  input: Omit<DelegationFailureReplyInput, 'modelText'>,
): string {
  const parts: string[] = [];
  if (input.reason === 'timeout') {
    parts.push("I couldn't get that done in time.");
    if (input.possiblySucceeded) parts.push('It may still be completing in the background.');
  } else if (input.reason === 'blocked') {
    parts.push('I ran into a block and couldn\'t finish that.');
  } else if (input.declined === true || input.reason === SPECIALIST_DECLINE_REASON) {
    parts.push("I wasn't able to take that one on.");
  } else {
    parts.push("I wasn't able to finish that.");
  }
  if (input.audience === 'sender') {
    if (input.escalated) parts.push("I'll follow up with you on it.");
    else if (retryMayHelp(input)) parts.push('You can ask me to try again in a bit.');
  } else if (input.escalated) {
    parts.push("I've logged a follow-up task to review the outcome.");
  } else if (retryMayHelp(input)) {
    parts.push('You can ask me to try again in a bit.');
  }
  return parts.join(' ');
}

/**
 * Whether suggesting a retry is sound advice. Not after a timeout that may have
 * gone through (a retry could send or post twice), and not after a decline or a
 * block, which a retry does not change.
 */
function retryMayHelp(input: Pick<DelegationFailureReplyInput, 'reason' | 'declined' | 'possiblySucceeded'>): boolean {
  if (input.reason === 'timeout') return input.possiblySucceeded !== true;
  if (input.reason === 'blocked') return false;
  return !(input.declined === true || input.reason === SPECIALIST_DECLINE_REASON);
}

/**
 * The message inside the last complete `<reply>…</reply>` block, trimmed.
 *
 * The narration prompt asks for the message inside these tags, so anything the
 * model writes around them (thinking out loud, restating the instructions) is
 * dropped by construction rather than detected. The last block wins: a model
 * that drafts, reconsiders and redrafts ends with its final answer. A block's
 * body never contains another `<reply>`: an opened-and-abandoned block followed
 * by a complete one must yield only the complete one, not the thinking between.
 * Null when there is no complete, non-empty block.
 */
export function extractReplyBlock(text: string): string | null {
  const blocks = [...text.matchAll(/<reply>((?:(?!<reply>)[\s\S])*?)<\/reply>/gi)];
  const last = blocks.at(-1);
  if (!last) return null;
  const body = (last[1] ?? '').trim();
  return body.length > 0 ? body : null;
}

// A complete note block. Same shape as the reply pattern: a body never contains another
// opening tag, so an abandoned opener followed by a complete block yields only the latter.
const NOTE_BLOCK = /<note_for_principal>((?:(?!<note_for_principal>)[\s\S])*?)<\/note_for_principal>/gi;
// Any note tag left in the reply once complete blocks are cut out. Looser than the block
// pattern on purpose: a variant spelling (`<note_for_principal >`, `<Note-For-Principal>`)
// is not cut out, so it must be caught here or its text would reach the sender.
// One whitespace run only (after the optional slash): two adjacent `\s*` around it would
// backtrack quadratically on a long run of spaces.
const NOTE_TAG = /<\/?\s*note[\s_-]*for[\s_-]*principal\b[^>]*>/i;
// Every note tag, for stripping out of recovered note text.
const NOTE_TAG_ALL = new RegExp(NOTE_TAG.source, 'gi');
// An opening tag left over once complete blocks are cut out: a note never closed, or the
// outer note of a nested pair (its inner block was cut out first).
const UNCLOSED_NOTE_OPEN = /<note_for_principal>/i;
// Where a leftover note's text ends: a reply tag, or the outer note's own closing tag.
const LEFTOVER_NOTE_END = /<\/?reply>|<\/note_for_principal>/i;
// The note lands in the principal's digest as part of a progress note, so it is folded
// onto one line and bounded like the other model- or sender-supplied text there.
const MAX_PRINCIPAL_NOTE = 1000;

/**
 * Split a sender-audience draft into the text the reply is read from and the note for
 * the principal (#1990). Every complete note block is cut out first, wherever it sits
 * (before, after or inside the reply block), so none of it can reach the sender.
 *
 * Distinct non-empty blocks are all kept, in source order: two blocks may be two
 * separate points, and an exact repeat is dropped. A leftover opening tag is a note
 * never closed (most often cut off by the output limit, since it comes last) or the
 * outer note of a nested pair. Its text is recovered from the raw draft up to a reply
 * tag, its own closing tag, or the end, with any inner note tags stripped, so a nested
 * note keeps its words in the order written. It is flagged `unclosed`. Its opening tag
 * stays in `rest`, so when it sits inside the reply the reply is still rejected as
 * `note_markup`.
 *
 * The note is sanitized, folded onto one line and bounded by code point.
 */
function splitPrincipalNote(raw: string): { rest: string; note?: string; unclosed?: true } {
  let notes = [...raw.matchAll(NOTE_BLOCK)].map((m) => ({ at: m.index, text: (m[1] ?? '').trim() }));
  // The reply is read from `rest`, where each block becomes one space. `blanked` keeps
  // every block's length, so a position found in it is the same position in `raw`.
  const rest = raw.replace(NOTE_BLOCK, ' ');
  const blanked = raw.replace(NOTE_BLOCK, (block) => ' '.repeat(block.length));
  const open = UNCLOSED_NOTE_OPEN.exec(blanked);
  if (open) {
    const start = open.index + open[0].length;
    const tail = blanked.slice(start).search(LEFTOVER_NOTE_END);
    const end = tail >= 0 ? start + tail : raw.length;
    // Taken from `raw`, so an inner block keeps its place; the inner block itself is then
    // dropped as a separate entry, since its words are already in the recovered text.
    const recovered = raw.slice(start, end).replace(NOTE_TAG_ALL, ' ').trim();
    notes = notes.filter((n) => n.at < open.index || n.at >= end);
    notes.push({ at: open.index, text: recovered });
  }
  const unclosed = open ? { unclosed: true as const } : {};
  const ordered = notes.filter((n) => n.text.length > 0).sort((a, b) => a.at - b.at).map((n) => n.text);
  const distinct = [...new Set(ordered)];
  if (distinct.length === 0) return { rest, ...unclosed };
  const folded = sanitizeOutput(distinct.join(' ')).replace(/\s+/g, ' ').trim();
  const note = Array.from(folded).slice(0, MAX_PRINCIPAL_NOTE).join('').trim();
  return note.length > 0 ? { rest, note, ...unclosed } : { rest, ...unclosed };
}

/**
 * Prefer the model's reply block when it passes every structural check.
 * Otherwise the deterministic fallback. `rejected` is set only when a draft came
 * back and was discarded; with no draft (call skipped, failed, or not text) the
 * runtime has already logged why.
 *
 * `principalNote` is the sender-audience note for the principal (#1990). It is
 * returned whether or not the reply was used: what the model wanted the principal to
 * know does not depend on whether its message to the sender passed. The principal
 * audience reads no note, so its path is as it was. `noteUnclosed` is set when a note
 * was opened and never closed, so the runtime can log it as a model regression.
 */
export function selectDelegationFailureReply(
  input: DelegationFailureReplyInput,
): {
  content: string;
  via: 'model' | 'fallback';
  rejected?: DraftRejection;
  principalNote?: string;
  noteUnclosed?: true;
} {
  const fallback = formatDelegationFailureFallback(input);
  if (input.modelText === undefined) return { content: fallback, via: 'fallback' };
  const trimmed = input.modelText.trim();
  const { rest, note, unclosed } = input.audience === 'sender'
    ? splitPrincipalNote(trimmed)
    : { rest: trimmed, note: undefined, unclosed: undefined };
  const withNote = {
    ...(note !== undefined && { principalNote: note }),
    ...(unclosed === true && { noteUnclosed: true as const }),
  };
  const raw = rest.trim();
  const outcome = trimmed.length === 0 ? 'empty' : checkDraft(raw, input);
  if (typeof outcome === 'string') return { content: fallback, via: 'fallback', rejected: outcome, ...withNote };
  return { content: outcome.reply, via: 'model', ...withNote };
}

function checkDraft(raw: string, input: DelegationFailureReplyInput): DraftRejection | { reply: string } {
  const reply = extractReplyBlock(raw);
  if (reply === null) return 'no_reply_block';
  // Complete note blocks were cut out before this. A tag still here is a note the model
  // opened and never closed, closed without opening, or spelled differently: its text
  // would reach the sender.
  if (input.audience === 'sender' && NOTE_TAG.test(reply)) return 'note_markup';
  if (containsRawAgentId(reply, input.agentId)) return 'agent_id';
  // Before names_specialist: protocol JSON carries "delegation_failure", and the
  // more specific reason is the more useful log line.
  if (reply.includes('_curia_protocol')) return 'protocol';
  if (namesSpecialist(reply, input.displayName)) return 'names_specialist';
  if (echoesInstructions(reply)) return 'prompt_echo';
  // Scheduler payloads carry the principal's contact id (#1800), and the model
  // sees the payload as the user turn. No reply to the principal needs a UUID.
  if (UUID_IN_TEXT.test(reply)) return 'uuid';
  if (input.audience === 'sender' && SENDER_INTERNAL_TERMS.test(reply)) return 'internal_note';
  if (input.audience === 'sender' && LOST_THREAD_TERMS.test(reply)) return 'lost_thread';
  if (input.audience === 'sender' && !input.escalated && FOLLOW_UP_PROMISE.test(reply)) return 'unbacked_promise';
  if (!sharesTopic(reply, input.request)) return 'off_topic';
  return { reply };
}

// Words that show a draft meant for an outside sender is also talking to, or about,
// the principal's side of things: the principal by role, or the follow-up task the
// situation line describes (#1978). An outside reader knows the principal by name,
// never as "the principal", and a failure reply has no reason to say "logged".
const SENDER_INTERNAL_TERMS = /\bprincipal\b|\bfollow-up task\b|\blogged\b|\binternal note\b/i;

// A promise to come back to the sender. Allowed only when the review task records
// them as waiting (#1978); otherwise nothing tracks it, and the prompt's "do not
// promise" line is all that stands between a model's habit and a broken promise.
const FOLLOW_UP_PROMISE = new RegExp([
  String.raw`\b(?:I['’]ll|I will|I['’]m going to|we['’]ll|we will)\s+(?:\w+\s+)?`
    + String.raw`(?:follow up|get back to you|be in touch|circle back|come back to you|update you|let you know)\b`,
  String.raw`\byou['’]ll hear (?:back )?from (?:me|us)\b`,
].join('|'), 'i');

// Telling an outside sender you have no record of their thread, or could not find
// or place it, is the disclosure #1978 is about: it tells them you lost the thread.
// Straight or curly apostrophes, since models write both.
const LOST_THREAD_TERMS = new RegExp([
  String.raw`\bno record\b`,
  String.raw`\b(?:don['’]?t|do not) have (?:a|any) record\b`,
  String.raw`\b(?:couldn['’]?t|could not|can['’]?t|cannot|unable to) (?:find|locate|place|track (?:\w+ )?down)\b`,
  String.raw`\blost (?:the thread|track)\b`,
].join('|'), 'i');

// The words the prompt forbids: "specialist(s)" and any form of "delegate". Exact
// terms, not phrasing, so this stays a structural check. Derived labels all end in
// "specialist", so this also covers "the calendar specialist".
const HANDOFF_TERMS = /\bspecialists?\b|\bdelegat/i;

/**
 * True when the draft talks about who the work was handed to.
 *
 * An explicit display name (`display_name: social team`) is matched on word
 * boundaries. The one use allowed is "your <label>": a label that is a domain
 * noun ("expense tracker") is how the principal names their own thing, so
 * "your expense tracker" is on topic. Any other use ("the social team
 * couldn't…") names the agent as the actor, even when the request mentioned it
 * too ("ask the social team to…"), so it is rejected. A false reject here only
 * costs the safe fallback.
 */
function namesSpecialist(reply: string, displayName: string): boolean {
  if (HANDOFF_TERMS.test(reply)) return true;
  const name = displayName.trim();
  if (name.length === 0) return false;
  const label = escapeRegExp(name);
  // Remove the allowed possessive uses, then look for any other.
  const withoutPossessive = reply.replace(new RegExp(`\\byour\\s+${label}\\b`, 'gi'), ' ');
  return new RegExp(`\\b${label}\\b`, 'i').test(withoutPossessive);
}

// Unanchored and unbounded: the UUID can sit anywhere, including glued to an id
// prefix (`contact_<uuid>`). 8-4-4-4-12 hex never occurs in prose, so there is no
// false reject to guard against. No /g, so no lastIndex state.
const UUID_IN_TEXT = new RegExp(UUID_PATTERN);

// Six consecutive words from an instruction line is a quotation, not a coincidence.
const ECHO_SHINGLE_WORDS = 6;

const INSTRUCTION_SHINGLES: ReadonlySet<string> = new Set(
  ALL_NARRATION_INSTRUCTIONS.flatMap((line) => shingles(words(line), ECHO_SHINGLE_WORDS)),
);

function echoesInstructions(reply: string): boolean {
  return shingles(words(reply), ECHO_SHINGLE_WORDS).some((s) => INSTRUCTION_SHINGLES.has(s));
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

function shingles(tokens: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i++) out.push(tokens.slice(i, i + size).join(' '));
  return out;
}

// Function words long enough to pass the length floor. They say nothing about
// what was asked, so sharing one does not show the draft is on topic. "principal"
// is here because the brief and scheduler payloads use it for the reader.
const NON_TOPIC_WORDS: ReadonlySet<string> = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'both', 'could', 'does',
  'doing', 'done', 'each', 'from', 'have', 'having', 'here', 'into', 'just', 'know',
  'like', 'make', 'more', 'most', 'much', 'need', 'only', 'other', 'over', 'please',
  'should', 'some', 'such', 'than', 'thanks', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'very', 'want', 'were', 'what', 'when', 'where',
  'which', 'while', 'will', 'with', 'would', 'your', 'yours', 'principal',
]);

// Words the narration prompt itself hands the model ("follow-up task", "in time",
// "background"). A stock reply uses them whatever was asked, so a request that
// happens to contain one ("add a task to follow up with Dana") must not count it.
const PROMPT_VOCABULARY: ReadonlySet<string> = new Set(
  [...ALL_NARRATION_INSTRUCTIONS, ...Object.values(SITUATION)].flatMap(words),
);

// Words shorter than this are mostly function words; the list above covers the rest.
const MIN_TOPIC_WORD = 4;
// Compare on a short prefix so "briefing" matches "brief" and "meeting" matches "meetings".
const TOPIC_PREFIX = 5;

function isTopicWord(word: string): boolean {
  return word.length >= MIN_TOPIC_WORD && !NON_TOPIC_WORDS.has(word) && !PROMPT_VOCABULARY.has(word);
}

/**
 * True when the reply shares at least one content word with the request.
 *
 * Replaces the verbatim-quote check (#1975): the reply names the request in its
 * own words, so this asks only that it is about the same thing. A request with no
 * content words cannot be checked, so any reply passes. (A draft that names the
 * specialist is rejected before this runs, so "calendar specialist" cannot stand
 * in for a request about the calendar.)
 */
function sharesTopic(reply: string, request: string): boolean {
  const topic = words(request).filter((w) => isTopicWord(w));
  if (topic.length === 0) return true;
  const replyWords = words(reply).filter((r) => isTopicWord(r));
  return topic.some((w) => {
    const stem = w.slice(0, TOPIC_PREFIX);
    // Forward: the reply word starts with the request word's stem ("briefings" for
    // "briefing"). Reverse: the reply word is a long enough prefix ("brief" for
    // "briefing"), or a short base the request word inflects ("trim" for "trimmed").
    // A short reply word that merely prefixes an unrelated one ("back" in "backup")
    // does not count.
    return replyWords.some((r) => r.startsWith(stem)
      || (r.length >= TOPIC_PREFIX && w.startsWith(r))
      || isInflectionOf(w, r));
  });
}

// Regular English inflections, enough to relate a short base to its forms.
const INFLECTION_SUFFIXES = ['s', 'es', 'ed', 'd', 'ing', 'er', 'ers'] as const;

/** True when `word` is `base` plus a regular suffix, allowing a doubled final consonant ("trim" → "trimmed"). */
function isInflectionOf(word: string, base: string): boolean {
  const last = base.at(-1) ?? '';
  return INFLECTION_SUFFIXES.some((suffix) => word === base + suffix || word === base + last + suffix);
}

/**
 * Text-only transcript for the narration call.
 *
 * The live transcript ends in an assistant `tool_use` followed by a user
 * `tool_result`. Providers omit `tools` when none are passed, and the
 * Messages API rejects tool blocks without a tools list. Those blocks are
 * dropped here. The narration prompt already states the failure, and a
 * text-only call cannot wander off into another tool round. Dropping them also
 * keeps the delegate brief and the specialist's decline prose out of context.
 */
export function transcriptForNarration(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const text = narrationMessageText(message.content);
    if (text.length === 0) continue;
    out.push({ role: message.role, content: text });
  }
  return out;
}

function narrationMessageText(content: Message['content']): string {
  if (typeof content === 'string') return content.trim().length === 0 ? '' : content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text.trim().length > 0) parts.push(block.text);
  }
  return parts.join('\n');
}
