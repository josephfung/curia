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
  | 'verification-code-received'
  | 'principal-forward'
  | 'booking-link'
  | 'make-room'
  | 'non-principal-reply-shaped'
  | 'principal-colleague'
  | 'principal-correspondent'
  | 'acquaintance-time-request'
  | 'recipient-outbound-context'
  | 'spot-check-reply'
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
 * The principal's message carried a code-shaped value the dispatcher registered for a
 * pending sms/app sign-in verification (#2017). Hedged ("appears to"): the value is only
 * code-shaped, and could be a booking reference. Without it the model sometimes
 * read past the code (in an email such as "482913 — once you're in, send me the notice")
 * and asked for it again. The runtime renders the named form
 * (verificationCodeReceivedLines) with the site, session and verification id; this
 * generic form is its fallback when that lookup fails. Neither ever holds the digits.
 */
const VERIFICATION_CODE_RECEIVED = [
  'The principal\'s message appears to contain the sign-in code for the verification in your',
  'Sign-in verifications block. If so, enter it now in that session; don\'t ask for it again.',
];

/**
 * The principal emailed Curia a forward (#2227). Without this, a bare forward read as FYI:
 * on the production standard-tier model Curia reached the sender in 2 of 5 runs (scenario
 * 25j) and asked the principal "Want me to offer them those?" in the rest. Replaces the
 * reply-shaped note, whose "ask what they are replying to" pulls the other way.
 */
const PRINCIPAL_FORWARD = [
  'The principal forwarded you someone else\'s email. Unless their note says otherwise ("FYI",',
  '"no action"), a forward means "please handle this": do what the forwarded message asks, on',
  'the principal\'s behalf, within your autonomy. A meeting request gets scheduled: check the',
  'calendar and reach the sender with times, or book through a booking link they gave. Don\'t',
  'ask the principal what they want done; tell them briefly what you did.',
];

/**
 * The inbound carries a booking-page link (#2227, bookingPageUrls). Without this, Curia
 * booked through a counterpart's Calendly in 3 of 5 runs (scenario 25k) and emailed times
 * in the rest; and every booking was followed by a calendar event of Curia's own, so the
 * counterpart got two invites. Conditional: the link may be one nobody asked Curia to use.
 */
const BOOKING_LINK = [
  'This message has a booking-page link (Calendly, a Google booking page or similar). When you',
  'are setting up a meeting with the page\'s owner for the principal, book through the page',
  'instead of proposing times by email: get the principal\'s free windows from the calendar',
  'specialist (no holds), open the page with `web-browser`, pick a slot free on both sides and',
  'book it with the principal\'s name and email. The page sends the invite, so create no event',
  'or hold of your own. Then confirm the booked time on the thread. Only if the page fails or',
  'has no slot that fits, offer times by email instead.',
];

/**
 * The principal asked Curia to make room for a meeting ("let me move a few things around",
 * #2227, looksLikeMakeRoom). Without this, at autonomy 84 Curia moved events in 1 of 10 runs
 * (scenario 25b) and otherwise offered slots over the principal's focus blocks; at 74 it
 * never asked first (25c, 0/5). What may move was already right: protected events were never
 * touched. The band rule follows the autonomy engine's high-risk floor (calendar writes, 80).
 */
const MAKE_ROOM = [
  'The principal asked you to make room for this meeting ("move things around", "free up',
  'time"). Offer only times that will be free: never a slot over an existing event unless that',
  'event is moved first. Keep to the window they gave. What may move, in this order: the',
  'principal\'s own blocks (focus time, admin, holds), then small internal meetings, then larger',
  'internal ones. Never move external meetings, ones with many stakeholders (board, offsite),',
  'or personal and medical appointments.',
  '- Autonomy 80 or above: have the calendar specialist move what is needed, then offer the',
  '  freed times, then tell the principal what moved.',
  '- Below 80: move nothing, and offer nothing over an existing event. Ask the principal',
  '  privately, never on the thread, with one specific proposal: what to move, and to when.',
  '  On the thread, a short holding note to the counterpart (times are coming) is fine.',
];

/**
 * The dispatcher raised this sender from `unknown` to `known` on evidence that the principal
 * knows them (#2227, src/contacts/principal-acquaintance.ts). Says what the evidence was:
 * without it the coordinator could not tell the sender had been checked, and in scenario
 * 25m sometimes treated a colleague as unvetted.
 */
const PRINCIPAL_COLLEAGUE = [
  'This sender is a colleague of the principal: their address is on the principal\'s',
  'organization domain. You had not dealt with them before, so the system made them a known',
  'contact on that basis.',
];

const PRINCIPAL_CORRESPONDENT = [
  'The principal has emailed this sender before (it is in the principal\'s Sent mail). You had',
  'not dealt with them before, so the system made them a known contact on that basis.',
];

/**
 * Follows either acquaintance note. Without it, once the sender was let in, a networking
 * request was booked into the next two workdays in 3 of 9 runs (scenario 25n).
 */
const ACQUAINTANCE_TIME_REQUEST = [
  'If they ask for the principal\'s time, first read the calendar, even if you will only ask the',
  'principal: a recommendation names real free times. Then weigh how much it matters. A',
  'time-bound, internal or sensitive request gets time soon (for a sensitive one, an invite',
  'title that does not name the matter). A discretionary one (networking, catching up, advice',
  'for themselves) gets one or two short call or video slots a week or more out, or a private',
  'ask to the principal with your recommendation. Either way, tell the principal.',
];

/** The named verification-code-received lines: one per verification the code was registered for. */
export function verificationCodeReceivedLines(
  items: ReadonlyArray<{ site: string; browserSessionId: string; id: string }>,
): string[] {
  return items.flatMap((v) => [
    `The principal's message appears to contain the sign-in code for ${v.site}.`,
    `If so, enter it now in session ${v.browserSessionId} (verification ${v.id}); don't ask for it again.`,
  ]);
}

/**
 * Any inbound from someone other than the principal (outbound context is limited to what
 * was sent to this sender, #2261). The first paragraph is every non-principal turn's reply contract, moved out of the always-on
 * prompt (prompt trim PR 4): principal turns never need it, and auto-generated mail, the
 * one non-principal turn without this block, has its own NO_REPLY preamble and never relays.
 * Anything for the principal goes in a note block, which the runtime cuts out of the reply
 * and the dispatcher emails to them (prompt trim PR 5, src/agents/principal-note.ts).
 *
 * The note line closes the block, as the delegation-failure prompt's format line does
 * (#1990), and says the note is emailed. Both were A/B'd on the production standard-tier
 * model: in the first paragraph, one note in five went untagged into the reply and routine
 * replies grew notes; closing the block without "emailed", 7 of 10 vendor deadlines reached
 * the principal; as written, 10 of 10 (baseline log, PR 5).
 *
 * The reply-shaped bullets say what to write and where the open question goes, not which
 * questions to keep from the sender (prompt trim PR 10). They name no tone and quote no
 * sample reply: how Curia sounds is the office identity's tone.style (#2143).
 */
const NON_PRINCIPAL_REPLY_SHAPED = [
  'Your final response is sent to this sender. The principal does not see it first, so it',
  'holds only your message to the sender. When nothing should go back (an automated notice,',
  'an FYI, a decline that needs no acknowledgment, a message not meant for you), the message',
  'is exactly NO_REPLY and nothing else.',
  '',
  'On these turns an [ACTIVE OUTBOUND CONTEXT] block shows only messages you sent to this',
  'sender; everything else is withheld, not empty. A message that',
  'mentions earlier contact you cannot find but makes a request you can act on ("Following up',
  'on the intro: could you share a few times?") is self-contained: act on it as usual, without',
  'first looking for the earlier contact. Only a message whose meaning depends on a thread you',
  'cannot see ("Yes, go ahead", "The second one works") is reply-shaped. For one of those:',
  '- Make one attempt to place it, such as a mailbox search on the subject line. If that finds',
  '  the thread, act on the message as you would any message from this sender.',
  '- If it does not, stop searching. Reply with a short acknowledgment that says only that',
  '  you will follow up: it agrees to nothing and never mentions the missing thread. Or reply',
  '  NO_REPLY when nothing needs to go back. In the note, ask the principal what it refers',
  '  to, giving who wrote, the subject, and what they said.',
  '',
  'Write the message to the sender, or NO_REPLY. If the principal needs to hear something from',
  'this exchange that they can act on, add it after the message inside',
  '<note_for_principal></note_for_principal> tags. The note is emailed to the principal and',
  'only they see it; nothing for the principal goes in the message.',
];

/**
 * A non-principal sender's turn carries a block of the messages Curia sent to them (#2261,
 * Fix B of #1848). Without it, "Thur Nov 5" from someone asked to pick a date read as a stray
 * message and got NO_REPLY (2026-10-21), and the answer was lost. The bullets mirror the
 * principal block's routing (OUTBOUND_CONTEXT, OUTBOUND_CONTEXT_TASK_WAKE) for a reply from
 * the recipient, including its match step: act on the entry the message answers, leave the
 * others open. The NO_REPLY override applies only to an answer; a message that answers no
 * entry keeps non-principal-reply-shaped's contract. No resume_token bullet: the recipient
 * block never renders one (outbound-context.ts), and clarification relays go to the principal.
 */
const RECIPIENT_OUTBOUND_CONTEXT = [
  'The [ACTIVE OUTBOUND CONTEXT] block lists messages you sent to this sender. Decide whether',
  'this message answers one of them. Act only on the entry it answers and leave the others open.',
  '- An answered entry with a `delegation:` line: delegate to that specialist with the sender\'s',
  '  full message as the task and the entry_id as `outbound_entry_id`.',
  '- An answered entry marked `bind_reply: true`: call `context-bridge-release` with that',
  '  entry_id and `reply` set to the sender\'s answer verbatim. If the message does not answer',
  '  its question, even when it is the only entry, do not call it: the binding stays open.',
  '- Any other answered entry: do the work the question was for. If a task is waiting on this',
  '  answer (task-list), record it there with task-update. Then call `context-bridge-release`',
  '  with the entry_id.',
  'Your final response is your only reply to the sender; never a separate send. After acting on',
  'an answer, it is a short acknowledgment, not NO_REPLY. A message that answers none of them',
  '(thanks, "I\'ll get back to you", a new question) is not an answer: call no',
  'context-bridge-release, leave every entry open, and handle the message as you would without',
  'this block.',
];

/**
 * A live principal message that looks like a verdict on a digest's spot check ("2 bad, that
 * was a renewal notice"). Added only on a live principal turn where Curia is not merely CC'd
 * (turn-guidance-triggers.ts), so a third party's "2 good" can never reach the tool. It names
 * the two calls in order because record-spot-check lives in the `reports` bundle, not the
 * coordinator's pins, and says to ask when the tool finds no match: a guessed verdict would
 * score the wrong action.
 *
 * Conditional on purpose (F1): the trigger is a start-of-message text rule, so "2 good"
 * answering one of Curia's own numbered questions fires it too. The block tells the
 * coordinator to ignore it then, and to read back what was recorded so a wrong match is
 * visible to the principal straight away (principal verdicts weigh 3x in the score).
 */
const SPOT_CHECK_REPLY = [
  'If the principal is grading a digest\'s spot check ("2 bad, that was a renewal notice"),',
  'call skill-activate with skill `reports`, then record-spot-check with each number, good or',
  'bad, and any reason given. If the number refers to something else, ignore this note. Tell',
  'the principal what was recorded (the tool returns each item\'s summary) and any numbers it',
  'skipped; if it finds no matching spot check or an unknown number, ask which action they',
  'meant. Never guess.',
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

/**
 * The principal CC'd Curia on an email to someone else. The last two lines (#2227): handed a
 * meeting, Curia asked the counterpart for windows instead of offering times in about a
 * quarter of runs (scenario 25a, 5 of 18 on main).
 */
const EMAIL_CC_PRINCIPAL = [
  'The principal copied you on an email to someone else; you are not the primary recipient.',
  'Read it as a whole and infer what they expect: they may be looping you in, making an',
  'introduction, delegating something, or keeping you informed. Don\'t ask them to repeat',
  'themselves. Look up every third party named or addressed in the email before responding.',
  'Only if the intent is genuinely ambiguous (two clearly contradictory readings) ask the',
  'principal, and then on a separate channel (e.g. Signal) or a new email thread, never on',
  'this thread, where third parties would see the question.',
  'When they hand you a meeting to set up, offer the other person specific times from the',
  'principal\'s calendar, in the window and format they gave; don\'t ask for their availability.',
  'If the other person shared a booking page, book through it instead (the booking-link note).',
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
  '- The `account` parameter on email-list, email-get, email-get-thread and email-archive',
  '  selects the mailbox. Omit it or pass your own account. Never read or archive the',
  '  principal\'s mailbox; anything about their email goes to ceo-inbox.',
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
  // The reply-channel reminder never fires here (the reply goes nowhere), so a scheduled
  // message gets its content rule at the point of writing instead (#2143).
  'A message you send keeps to the Length section of your identity block for its channel.',
  'Say what is there, not what isn\'t: leave out empty results, things that did not happen and',
  'what you will do next, and do not repeat the task\'s instructions back.',
];

const TURN_GUIDANCE: Record<TurnGuidanceKey, readonly string[]> = {
  'principal-reply-shaped': PRINCIPAL_REPLY_SHAPED,
  'verification-code-received': VERIFICATION_CODE_RECEIVED,
  'principal-forward': PRINCIPAL_FORWARD,
  'booking-link': BOOKING_LINK,
  'make-room': MAKE_ROOM,
  'non-principal-reply-shaped': NON_PRINCIPAL_REPLY_SHAPED,
  'principal-colleague': PRINCIPAL_COLLEAGUE,
  'principal-correspondent': PRINCIPAL_CORRESPONDENT,
  'acquaintance-time-request': ACQUAINTANCE_TIME_REQUEST,
  'recipient-outbound-context': RECIPIENT_OUTBOUND_CONTEXT,
  'spot-check-reply': SPOT_CHECK_REPLY,
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
  // Straight after the reply-shaped note: a bare code is not a reply needing clarification.
  'verification-code-received',
  'principal-forward',
  // After the forward note: a forwarded booking page is booked through, not answered by email.
  'booking-link',
  'make-room',
  'non-principal-reply-shaped',
  // After the reply contract: who this sender is to the principal, then how to weigh a request.
  'principal-colleague',
  'principal-correspondent',
  'acquaintance-time-request',
  'recipient-outbound-context',
  'spot-check-reply',
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
 * given in, each at most once. `named` replaces a key's fixed text with lines the runtime
 * resolved for this turn (verification-code-received names its verification). The backlog line (src/agents/prompts/backlog-line.ts), when
 * given, follows them; the reply's length reminder (src/identity/length.ts,
 * turnLengthReminder), when given, closes the block, nearest the message it applies to.
 * Null when there is nothing to render.
 */
export function renderTurnGuidance(
  keys: readonly TurnGuidanceKey[],
  backlogLine?: string | null,
  lengthReminder?: string | null,
  named?: Partial<Record<TurnGuidanceKey, readonly string[]>>,
): string | null {
  const wanted = new Set(keys);
  let out = TURN_GUIDANCE_HEADER;
  let previous: TurnGuidanceKey | undefined;
  for (const key of TURN_GUIDANCE_ORDER) {
    if (!wanted.has(key)) continue;
    // The outbound-context sub-rules continue that block's bullet list, so they join with
    // a single newline; every other section is its own paragraph.
    const continuesList = key.startsWith('outbound-context-') && previous?.startsWith('outbound-context') === true;
    const lines = named?.[key]?.length ? named[key] : TURN_GUIDANCE[key];
    out += (continuesList ? '\n' : '\n\n') + lines.join('\n');
    previous = key;
  }
  const closing = [backlogLine, lengthReminder].filter((line): line is string => typeof line === 'string' && line !== '');
  if (previous === undefined && closing.length === 0) return null;
  return closing.reduce((text, line) => `${text}\n\n${line}`, out);
}

/** Every turn-guidance block, for prompt-exfiltration marker extraction. */
export const TURN_GUIDANCE_TEXTS: readonly string[] = TURN_GUIDANCE_ORDER.map((key) => TURN_GUIDANCE[key].join('\n'));
