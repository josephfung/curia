// specialist-answer.ts — what a specialist's answer did and did not send (#2055).
//
// A specialist's prose can call an email "sent" when it only composed it: calendar has no
// email skill, and once wrote its draft up as "## Email sent to Jamie". The caller learned
// that from the text alone and told the principal the email was out. This shapes the answer
// from facts instead: `sent` from the runtime's record of successful sends, composed email
// lifted out of <scheduling_email> blocks, and a next step when text was not sent. Used by
// the delegate skill's result and by the late-result brief, so both paths say the same.

import { isHumanReplySkill } from '../dispatch/origin-turn-reply.js';
import { DRAFT_EMAIL_NEXT_STEP, NOTHING_SENT_NEXT_STEP } from './prompts/delegate-result-guidance.js';
import { extractSchedulingEmails, type SchedulingEmailDraft } from './scheduling-email.js';

/** Words that mean a send was asked for or claimed. Only gates the nothing-sent note, which is
 *  true whenever no email or message went out, so a loose match costs a sentence, never a
 *  wrong statement. */
const SEND_WORDING = /\b(?:send|sends|sent|sending|e-?mailed|invited?|invites|invitation|notif(?:y|ied)|reached out|(?:went|is|are) out)\b/i;

export interface SpecialistAnswer {
  /** The specialist's text with any <scheduling_email> blocks removed. */
  response: string;
  /** Successful sends in the specialist's task; absent when the runtime did not report them. */
  sent?: string[];
  draft_emails?: SchedulingEmailDraft[];
  next_step?: string;
}

/**
 * Shape a specialist's ordinary answer. `sends` is `agent.response.sends`; `task` is the brief
 * the specialist was given ('' when unknown).
 *
 * The nothing-sent note keys on email and message sends only. A calendar invite or update can
 * go out alongside a false "email sent" line, and calendar can never truthfully claim an email.
 */
export function shapeSpecialistAnswer(content: string, sends: string[] | undefined, task: string): SpecialistAnswer {
  const { drafts, text } = extractSchedulingEmails(content);
  const nextStep = drafts.length > 0
    ? DRAFT_EMAIL_NEXT_STEP
    : sends !== undefined && !sends.some(isHumanReplySkill) && (SEND_WORDING.test(text) || SEND_WORDING.test(task))
      ? NOTHING_SENT_NEXT_STEP
      : undefined;
  return {
    response: text,
    ...(sends !== undefined && { sent: sends }),
    ...(drafts.length > 0 && { draft_emails: drafts }),
    ...(nextStep !== undefined && { next_step: nextStep }),
  };
}

/** `agent.response.sends` from an untyped payload (late delivery reads it back from the bus or audit log). */
export function sendsFromPayload(payload: Record<string, unknown>): string[] | undefined {
  const sends = payload['sends'];
  return Array.isArray(sends) && sends.every((s) => typeof s === 'string') ? (sends as string[]) : undefined;
}
