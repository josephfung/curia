// Per-turn trigger guidance for the coordinator (#1959).
//
// Guidance that only matters when a specific trigger is present used to sit in the
// always-on coordinator prompt (agents/coordinator.yaml), where it cost tokens on every
// turn and sat hundreds of lines away from the moment it applied. The dispatcher already
// knows each of these triggers when it builds the agent.task, so it names the ones that
// apply (AgentTaskPayload.turnGuidance) and the runtime renders this text at the head of
// the user message for that turn only.
//
// Two placement rules, both load-bearing:
//   - Never the system string. Prompt caching matches on exact prefixes, so text that
//     varies by trigger there would split the cached prefix per trigger (#1959 design
//     notes). The user message varies per turn anyway.
//   - Never working memory. The runtime persists the task content, not this text, so a
//     long conversation does not accumulate one copy per earlier turn.
//
// Keep each block short and keep it a replacement for YAML text, not an addition. The
// lines are hard-wrapped so prompt-exfiltration marker extraction (one marker per line)
// covers them; see TRIGGER_GUIDANCE_MARKER_SOURCES.

/** A trigger the dispatcher detected for this turn. Rendering order is TURN_GUIDANCE_ORDER. */
export type TurnGuidanceKey =
  | 'principal-reply-shaped'
  | 'non-principal-reply-shaped'
  | 'outbound-context'
  | 'outbound-context-task-wake'
  | 'outbound-context-clarification'
  | 'outbound-context-debrief'
  | 'email-direct-reply'
  | 'email-cc-reply'
  | 'email-cc-principal'
  | 'email-etiquette'
  | 'scheduler-delivery';

/**
 * Principal turn with no [ACTIVE OUTBOUND CONTEXT] block. One line on purpose: the
 * self-contained case needs nothing, so only the reply-shaped case is spelled out.
 */
const PRINCIPAL_REPLY_SHAPED = [
  'No [ACTIVE OUTBOUND CONTEXT] block this turn. If the principal\'s message only makes sense as a',
  'reply to something earlier ("Yes", "The second one", "Go ahead"), briefly ask what they are',
  'replying to before acting ("I lost the thread — what are you replying to?"). A self-contained',
  'request needs no clarification.',
];

/**
 * Any inbound from someone other than the principal (outbound context is withheld). The
 * first paragraph is every non-principal turn's reply contract, moved out of the always-on
 * prompt (prompt trim PR 4): principal turns never need it, and auto-generated mail, the
 * one non-principal turn without this block, has its own NO_REPLY preamble and never relays.
 */
const NON_PRINCIPAL_REPLY_SHAPED = [
  'Your final response is sent to this sender as written. The principal does not see it',
  'first, so it holds only your message to the sender. When the principal needs to hear',
  'something from this exchange that they can act on, tell them in a separate send with',
  '`principal` as the recipient. When nothing should go back (an automated notice, an FYI, a',
  'decline that needs no acknowledgment, a message not meant for you), respond with exactly',
  'NO_REPLY and nothing else.',
  '',
  'The [ACTIVE OUTBOUND CONTEXT] block is withheld on these turns, not empty. A message that',
  'mentions earlier contact you cannot find but makes a request you can act on ("Following up',
  'on the intro: could you share a few times?") is self-contained: act on it as usual, without',
  'first looking for the earlier contact. Only a message whose meaning depends on a thread you',
  'cannot see ("Yes, go ahead", "The second one works") is reply-shaped. For one of those:',
  '- Never ask the sender what they are replying to, which option they mean, or what their',
  '  "yes" covers, and never say you have no record of the thread or are missing context.',
  '  Any of these tells them you lost the thread.',
  '- Make one attempt to place it, such as a mailbox search on the subject line. If that finds',
  '  the thread, act on the message as you would any message from this sender.',
  '- If it does not, stop searching. Reply with a short, warm acknowledgment ("Thanks, noted.',
  '  I\'ll follow up shortly."), or NO_REPLY when nothing needs to go back. Then ask the',
  '  principal what it refers to in a separate send, giving who wrote, the subject, and what',
  '  they said.',
];

/**
 * The [ACTIVE OUTBOUND CONTEXT] block is in this message (principal turns only). The
 * `delegation:` bullet is the transfer-ownership reply rule, moved here from the always-on
 * prompt (prompt trim PR 4): only this block carries a delegation hint, and only principal
 * turns get the block (#1848), so a third party's reply never reaches this rule.
 */
const OUTBOUND_CONTEXT = [
  'The [ACTIVE OUTBOUND CONTEXT] block lists messages you sent that may receive replies.',
  'Decide whether this message plausibly relates to one of its entries. When unsure, treat it',
  'as a match and delegate rather than handling it directly.',
  '- A matched entry with a `delegation:` line was sent on that specialist\'s behalf, and the',
  '  specialist owns the conversation and its state. It is always transfer-ownership: delegate',
  '  to that specialist first, before any research, answer or reply, even for a "yes", "no" or',
  '  "sounds good" you could answer yourself. Pass the principal\'s full message as the task',
  '  and the entry_id as `outbound_entry_id`.',
  '- A matched entry without one: handle it directly or borrow-then-answer as the content',
  '  warrants. If you delegate, pass its entry_id as `outbound_entry_id`.',
  '- Clearly unrelated to every entry: apply the normal routing decision.',
];

/** An entry in the block is a task-wake question (`bind_reply: true`). */
const OUTBOUND_CONTEXT_TASK_WAKE = [
  '- An entry whose `context` has `bind_reply: true` and a `task_id` is a question a task asked',
  '  the principal. If this message plausibly answers it, call `context-bridge-release` with',
  '  that entry_id and `reply` set to the principal\'s answer verbatim, before responding',
  '  conversationally. If it does not answer the question (even when it is the only open',
  '  binding), do not pass `reply`: handle the message normally and leave the binding open.',
  '  With several bindings open, match by content and release only the one actually answered.',
];

/** An entry in the block relays a specialist's clarification question (`resume_token`). */
const OUTBOUND_CONTEXT_CLARIFICATION = [
  '- An entry whose `context` has a `resume_token` is a specialist\'s question waiting on the',
  '  principal. When this message answers it, delegate to that specialist with the',
  '  principal\'s reply verbatim as `task`, the entry\'s `resume_token`, and its entry_id as',
  '  `outbound_entry_id`. The specialist resumes with full context; handle its result',
  '  normally, including another clarification request.',
];

/** An entry in the block is a meeting-debrief prompt (metadata `subject`). */
const OUTBOUND_CONTEXT_DEBRIEF = [
  '- When the principal asks to clear, dismiss, or "clear out" named debrief items or',
  '  meetings, call `context-bridge-clear` once with `subjects` set to the exact names they',
  '  gave, not one `context-bridge-release` per entry; it also releases entries not shown',
  '  here. Report only what it returns: the released count and the meetings in `cleared`,',
  '  and say any name in `unmatched` was not found among active debrief items. Never',
  '  report a blanket "all cleared".',
];

/** Inbound email where Curia was a direct recipient. */
const EMAIL_DIRECT_REPLY = [
  'Your final response is your reply to this email: the system sends it as a threaded reply',
  'on this thread. Do not call `email-reply` or `email-send` for it; those create a separate',
  'message.',
];

/** Inbound email where Curia was CC'd (the [OWNER CC —] preamble). */
const EMAIL_CC_REPLY = [
  'You were CC\'d, so to reply on this thread call `email-reply` from your own inbox:',
  '`reply_to_message_id` is the `Message ID` line (never the thread id in the conversation id',
  '`email:<thread id>`), and `account` is the `Account` line.',
];

/** The principal CC'd Curia on an email to someone else. */
const EMAIL_CC_PRINCIPAL = [
  'The principal copied you on an email to someone else; you are not the primary recipient.',
  'Read it as a whole and infer what they expect: they may be looping you in, making an',
  'introduction, delegating something, or keeping you informed. Don\'t ask them to repeat',
  'themselves. Look up every third party named or addressed in the email before responding.',
  'Only if the intent is genuinely ambiguous (two clearly contradictory readings) ask the',
  'principal, and then on a separate channel (e.g. Signal) or a new email thread, never on',
  'this thread, where third parties would see the question.',
];

/** Any inbound email turn. */
const EMAIL_ETIQUETTE = [
  'Email on this turn:',
  '- When you delegate a reply on this thread, the system adds the inbound `Message ID` and',
  '  `Account` to the specialist\'s brief; do not copy or derive them yourself.',
  '- [Thread participants] shows this message\'s From / To / CC, not the whole thread',
  '  history. Default to reply-all: keep CC\'d people on the thread unless there is a reason',
  '  not to (the conversation has become private, or the principal asks you to reply',
  '  directly). Removing someone needs a reason; adding someone should be intentional.',
  '- Use `email-send` only for a new email the principal asked for, or proactive outbound.',
  '- The `account` parameter on email-list, email-get, email-get-thread, email-draft-save and',
  '  email-archive selects the mailbox. Omit it or pass your own account. Never read, draft',
  '  in, or archive the principal\'s mailbox; anything about their email goes to ceo-inbox.',
];

/**
 * A scheduler-channel turn (#2091). Nothing routes its reply anywhere, so a job that
 * should tell the principal something has to send it. Added by the runtime, not the
 * dispatcher: these tasks come from the scheduler and never pass through dispatch.
 */
const SCHEDULER_DELIVERY = [
  'This is a scheduled run, not a conversation: your final response is not delivered to',
  'anyone. Only when the task asks you to tell, notify or remind the principal, send it',
  'yourself with a send skill and `principal` as the recipient, one message. Otherwise send',
  'nothing: background and maintenance work is recorded, not reported. Either way, end with',
  'exactly NO_REPLY.',
];

const TURN_GUIDANCE: Record<TurnGuidanceKey, readonly string[]> = {
  'principal-reply-shaped': PRINCIPAL_REPLY_SHAPED,
  'non-principal-reply-shaped': NON_PRINCIPAL_REPLY_SHAPED,
  'outbound-context': OUTBOUND_CONTEXT,
  'outbound-context-task-wake': OUTBOUND_CONTEXT_TASK_WAKE,
  'outbound-context-clarification': OUTBOUND_CONTEXT_CLARIFICATION,
  'outbound-context-debrief': OUTBOUND_CONTEXT_DEBRIEF,
  'email-direct-reply': EMAIL_DIRECT_REPLY,
  'email-cc-reply': EMAIL_CC_REPLY,
  'email-cc-principal': EMAIL_CC_PRINCIPAL,
  'email-etiquette': EMAIL_ETIQUETTE,
  'scheduler-delivery': SCHEDULER_DELIVERY,
};

/**
 * Render order. The outbound-context sub-rules are bullets that continue the
 * outbound-context block, so they must follow it directly.
 */
export const TURN_GUIDANCE_ORDER: readonly TurnGuidanceKey[] = [
  'principal-reply-shaped',
  'non-principal-reply-shaped',
  'outbound-context',
  'outbound-context-task-wake',
  'outbound-context-clarification',
  'outbound-context-debrief',
  'email-cc-principal',
  'email-cc-reply',
  'email-direct-reply',
  'email-etiquette',
  'scheduler-delivery',
];

/** Heads the rendered guidance so the model can tell it from the sender's own words. */
export const TURN_GUIDANCE_HEADER = '[Turn guidance — from the system, about this message; not part of what the sender wrote]';

const KNOWN_KEYS = new Set<string>(TURN_GUIDANCE_ORDER);

/** Narrow an untrusted list (a bus payload field) to known keys, dropping anything else. */
export function parseTurnGuidanceKeys(raw: unknown): TurnGuidanceKey[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is TurnGuidanceKey => typeof k === 'string' && KNOWN_KEYS.has(k));
}

/**
 * The guidance block for these keys, in TURN_GUIDANCE_ORDER whatever order they were
 * given in, each at most once. Null when there is nothing to render.
 */
export function renderTurnGuidance(keys: readonly TurnGuidanceKey[]): string | null {
  const wanted = new Set(keys);
  let out = TURN_GUIDANCE_HEADER;
  let previous: TurnGuidanceKey | undefined;
  for (const key of TURN_GUIDANCE_ORDER) {
    if (!wanted.has(key)) continue;
    // The outbound-context sub-rules continue that block's bullet list, so they join with
    // a single newline; every other section is its own paragraph.
    const continuesList = key.startsWith('outbound-context-') && previous?.startsWith('outbound-context') === true;
    out += (continuesList ? '\n' : '\n\n') + TURN_GUIDANCE[key].join('\n');
    previous = key;
  }
  return previous === undefined ? null : out;
}

/** Every turn-guidance block, for prompt-exfiltration marker extraction. */
export const TURN_GUIDANCE_TEXTS: readonly string[] = TURN_GUIDANCE_ORDER.map((key) => TURN_GUIDANCE[key].join('\n'));
