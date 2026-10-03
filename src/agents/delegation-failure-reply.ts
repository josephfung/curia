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

import type { Message } from './llm/provider.js';
import { SPECIALIST_DECLINE_REASON } from './specialist-decline.js';
import { containsRawAgentId } from './agent-display-name.js';
import { UUID_PATTERN } from '../util/uuid.js';

export interface DelegationFailureReplyInput {
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
  | 'protocol'
  | 'prompt_echo'
  | 'uuid'
  | 'off_topic';

// The instruction lines of the narration prompt. Kept apart from the situation lines
// (what failed, whether a follow-up was logged) because a good reply restates those
// facts, while it never has a reason to repeat an instruction. The echo check runs
// against these lines only.
const REFER_TO_SPECIALIST = 'Refer to the specialist only as';
const NARRATION_INSTRUCTIONS = [
  'A delegated task failed. Write the one message the principal will read.',
  'Address them directly as "you".',
  // Completed with the display name when the prompt is built. Its fixed part is
  // what the #1975 draft echoed, so it is shingled like the other lines.
  REFER_TO_SPECIALIST,
  'Do not use internal agent ids, tool names, IDs, or protocol markers.',
  'Say briefly, in your own words, what you were trying to do for them.',
  'Write it as a fresh sentence about this request. Do not reuse a stock line.',
  'Do not call tools. Put only the message inside <reply></reply> tags.',
] as const;

// Every situation and follow-up line the prompt can carry. Listed in one place so
// the topic check can discount their words (see PROMPT_VOCABULARY).
const SITUATION = {
  timeout: 'The specialist did not answer in time.',
  timeoutMaybeDone: 'The specialist did not answer in time. The work may still be finishing in the background.',
  blocked: 'The specialist was blocked and could not finish.',
  declined: 'The specialist declined the task.',
  other: 'The specialist was not able to finish the task.',
  escalated: 'A follow-up task has already been logged.',
  notEscalated: 'A follow-up task could not be logged.',
} as const;

export function delegationFailureNarrationPrompt(input: {
  displayName: string;
  reason: string;
  possiblySucceeded?: boolean;
  escalated: boolean;
  declined?: boolean;
}): string {
  const situation = describeFailure(input.reason, input.declined, input.possiblySucceeded);
  const followUp = input.escalated ? SITUATION.escalated : SITUATION.notEscalated;
  return NARRATION_INSTRUCTIONS.flatMap((line) => {
    if (line === REFER_TO_SPECIALIST) return [`${line} "${input.displayName}".`];
    // The situation sits just before the closing format line.
    if (line === NARRATION_INSTRUCTIONS.at(-1)) return [situation, followUp, line];
    return [line];
  }).join('\n');
}

function describeFailure(reason: string, declined: boolean | undefined, possiblySucceeded: boolean | undefined): string {
  if (reason === 'timeout') return possiblySucceeded ? SITUATION.timeoutMaybeDone : SITUATION.timeout;
  if (reason === 'blocked') return SITUATION.blocked;
  if (declined === true || reason === SPECIALIST_DECLINE_REASON) return SITUATION.declined;
  return SITUATION.other;
}

/**
 * Deterministic reply. It names the specialist and the kind of failure, and
 * deliberately says nothing about the request: the only request text on hand is
 * the brief (written for the specialist) or the turn content (which may be a
 * scheduler payload or carry a channel preamble). Quoting either is how #1975
 * leaked. The model path is what names the request.
 */
export function formatDelegationFailureFallback(
  input: Omit<DelegationFailureReplyInput, 'modelText'>,
): string {
  const who = input.displayName;
  const parts: string[] = [];
  if (input.reason === 'timeout') {
    parts.push(`I didn't hear back from the ${who} in time, so I couldn't finish that.`);
    if (input.possiblySucceeded) parts.push('It may still be completing in the background.');
  } else if (input.reason === 'blocked') {
    parts.push(`The ${who} was blocked and couldn't finish that.`);
  } else if (input.declined === true || input.reason === SPECIALIST_DECLINE_REASON) {
    parts.push(`The ${who} declined that request, so I couldn't finish it.`);
  } else {
    parts.push(`The ${who} wasn't able to finish that.`);
  }
  if (input.escalated) {
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

/**
 * Prefer the model's reply block when it passes every structural check.
 * Otherwise the deterministic fallback. `rejected` is set only when a draft came
 * back and was discarded; with no draft (call skipped, failed, or not text) the
 * runtime has already logged why.
 */
export function selectDelegationFailureReply(
  input: DelegationFailureReplyInput,
): { content: string; via: 'model' | 'fallback'; rejected?: DraftRejection } {
  const fallback = formatDelegationFailureFallback(input);
  if (input.modelText === undefined) return { content: fallback, via: 'fallback' };
  const raw = input.modelText.trim();
  const outcome = raw.length === 0 ? 'empty' : checkDraft(raw, input);
  if (typeof outcome === 'string') return { content: fallback, via: 'fallback', rejected: outcome };
  return { content: outcome.reply, via: 'model' };
}

function checkDraft(raw: string, input: DelegationFailureReplyInput): DraftRejection | { reply: string } {
  const reply = extractReplyBlock(raw);
  if (reply === null) return 'no_reply_block';
  if (containsRawAgentId(reply, input.agentId)) return 'agent_id';
  if (reply.includes('_curia_protocol')) return 'protocol';
  if (echoesInstructions(reply)) return 'prompt_echo';
  // Scheduler payloads carry the principal's contact id (#1800), and the model
  // sees the payload as the user turn. No reply to the principal needs a UUID.
  if (UUID_IN_TEXT.test(reply)) return 'uuid';
  if (!sharesTopic(reply, input.request, input.displayName)) return 'off_topic';
  return { reply };
}

// Unanchored and unbounded: the UUID can sit anywhere, including glued to an id
// prefix (`contact_<uuid>`). 8-4-4-4-12 hex never occurs in prose, so there is no
// false reject to guard against. No /g, so no lastIndex state.
const UUID_IN_TEXT = new RegExp(UUID_PATTERN);

// Six consecutive words from an instruction line is a quotation, not a coincidence.
const ECHO_SHINGLE_WORDS = 6;

const INSTRUCTION_SHINGLES: ReadonlySet<string> = new Set(
  NARRATION_INSTRUCTIONS.flatMap((line) => shingles(words(line), ECHO_SHINGLE_WORDS)),
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
  [...NARRATION_INSTRUCTIONS, ...Object.values(SITUATION)].flatMap(words),
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
 * own words, so this asks only that it is about the same thing. The specialist's
 * display name is removed from the reply first. Otherwise "calendar specialist"
 * would satisfy a request about the calendar with a stock line. A request with no
 * content words cannot be checked, so any reply passes.
 */
function sharesTopic(reply: string, request: string, displayName: string): boolean {
  const topic = words(request).filter((w) => isTopicWord(w));
  if (topic.length === 0) return true;
  // Guard the split: an empty name would split the reply into single characters.
  const name = displayName.trim().toLowerCase();
  const withoutName = name.length > 0 ? reply.toLowerCase().split(name).join(' ') : reply.toLowerCase();
  const replyWords = words(withoutName).filter((r) => isTopicWord(r));
  return topic.some((w) => {
    const stem = w.slice(0, TOPIC_PREFIX);
    // Either direction: "briefings" in the reply for "briefing", or "trim" for "trimmed".
    return replyWords.some((r) => r.startsWith(stem) || w.startsWith(r));
  });
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
