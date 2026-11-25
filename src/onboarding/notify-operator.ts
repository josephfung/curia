// notify-operator.ts — tell the operator about onboarding trouble (#2360, #2710).
//
// The operator is the person who set Curia up when that was not the principal (an EA, an IT
// person, a technical friend). During onboarding they are the one who can unblock Setup: trust
// a Google app, check a key, send a fresh invitation. This module records the notice on the
// onboarding task and has it emailed through the one system-notice path, OutboundGateway
// .sendNotification — the notification types are all operator-routed (NOTIFICATION_AUDIENCES,
// ADR-068), so the gateway addresses them and the operator hears about it once per onboarding run.
//
// Two rules keep the emailed text safe:
//   - **Nothing model-supplied is emailed.** The notice carries the event, plus facts typed on
//     OperatorNotice (the OAuth client id to trust). Free-form `details` from a tool call reach
//     the task note, the log and the audit row by key name only.
//   - **No principal content.** The bodies name what went wrong and what the operator can do;
//     no message text, addresses or objectives.

import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';

export const OPERATOR_EVENTS = [
  'greeting_unanswered',
  'invitation_expired',
  'web_search_failed',
  'mailbox_signin_blocked',
  'deep_dive_failed',
] as const;
export type OperatorEvent = (typeof OPERATOR_EVENTS)[number];

/** Facts the emailed notice may carry. Typed on purpose: every field here is code-read, not
 *  model-written, so nothing a model put in a tool call can reach the email. */
export interface OperatorNotice {
  /** mailbox_signin_blocked: the Google OAuth client id a Workspace admin must trust. */
  clientId?: string;
  /**
   * greeting_unanswered: no greeting was ever recorded (the watcher's `greeting_not_recorded`),
   * so there is no reply to wait for. Set by Curia, never by a model.
   */
  greetingNotRecorded?: boolean;
  /**
   * Context for the task note, the log and the audit row only — never the email. These values
   * can be model-supplied (a tool call's `details`), so only their key names are logged.
   */
  details?: Record<string, unknown>;
}

export type NotifyOperatorDeps = {
  taskRepo: Pick<TaskRepo, 'updateTask'>;
  logger: Logger;
  /**
   * How the notice is emailed (#2710). Absent (no outbound gateway, as in tests): the note is
   * still recorded and nobody is emailed — the notice is never lost, only undelivered.
   */
  gateway?: Pick<OutboundGateway, 'sendNotification'>;
  /** The console's origin, for the notice's link. Absent: the notice has no link line. */
  appOrigin?: string;
  audit?: (e: Record<string, unknown>) => void;
  /**
   * A pre-bound notifier, when one was injected rather than built from the fields above.
   * notifyOperatorOnce delegates to it; notifyOperator itself ignores it.
   */
  notifier?: OperatorNotifier;
};

/**
 * What became of an operator notice: `recorded` is whether the task's progress note (the durable
 * record that the notice was raised) was written. The email beside it is best-effort.
 */
export interface OperatorNoticeResult {
  recorded: boolean;
}

/** A notice to send, bound to its delivery deps. Injected where the gateway is not in reach. */
export type OperatorNotifier = (taskId: string | null, event: OperatorEvent, notice?: OperatorNotice) => Promise<OperatorNoticeResult>;

/** Bind the delivery deps, so a caller that only knows the task and the event can send one. */
export function createOperatorNotifier(deps: NotifyOperatorDeps): OperatorNotifier {
  return (taskId, event, notice) => notifyOperator(deps, taskId, event, notice);
}

const GENERIC_CLIENT_ID = 'the OAuth client ID from your Google Cloud project';

/** The subject and body lines for each event. Operator-safe by construction: no principal
 *  content, no model-supplied values, no addresses. */
function noticeText(
  event: OperatorEvent,
  notice: OperatorNotice,
): { subject: string; lines: string[] } {
  switch (event) {
    case 'greeting_unanswered':
      if (notice.greetingNotRecorded === true) {
        return {
          subject: 'Curia onboarding: the greeting was never recorded as sent',
          lines: [
            'Curia started onboarding, but no greeting to the principal was recorded as sent, even after it was asked again.',
            '',
            'There is no reply to wait for. Check where onboarding got to in the console.',
          ],
        };
      }
      return {
        subject: 'Curia onboarding: the greeting went unanswered',
        lines: [
          'The onboarding greeting to the principal went unanswered, even after the follow-ups.',
          '',
          'Nothing is broken: Curia is waiting for a reply in the app or by email. You can see where onboarding got to in the console.',
        ],
      };
    case 'invitation_expired':
      return {
        subject: 'Curia onboarding: the invitation link expired',
        lines: [
          'The invitation link sent to the principal expired before it was used.',
          '',
          'Send a fresh one from the app invitation screen in the console.',
        ],
      };
    case 'web_search_failed':
      return {
        subject: 'Curia onboarding: web search failed',
        lines: [
          'Web search failed while Curia was doing the onboarding homework.',
          '',
          'Onboarding carries on without it. If it keeps failing, check the search provider key in the console.',
        ],
      };
    case 'mailbox_signin_blocked':
      return {
        subject: 'Curia onboarding: a Google admin policy blocked the mailbox sign-in',
        lines: [
          "A Google Workspace administrator's policy blocked the principal's mailbox sign-in.",
          '',
          `To allow it, a Workspace administrator opens the Google Admin console → Security → Access and data control → API controls → App access control, adds the app by ${notice.clientId !== undefined ? `the OAuth client ID ${notice.clientId}` : GENERIC_CLIENT_ID}, and marks it Trusted.`,
          '',
          'Once the app is trusted, the sign-in can be tried again.',
        ],
      };
    case 'deep_dive_failed':
      return {
        subject: 'Curia onboarding: the mailbox history review failed',
        lines: [
          "Curia's one-time review of the principal's mail and calendar history stopped with an error.",
          '',
          "Onboarding carries on without it. The cause is in Curia's logs.",
        ],
      };
  }
}

/**
 * Record an operator notice on the onboarding task and email it to the operator. Never throws.
 * `taskId` null (a deep dive that failed with no task to note it on, #2362): nothing is recorded
 * on a task, `recorded` is false, and the notice is still logged, emailed and audited.
 * `recorded` is false when the progress note could not be written (logged). The email is
 * best-effort beside the record: a failed send is logged, and does not un-record the notice. The audit call is best-effort too: once the note is written
 * the notice counts as recorded.
 */
export async function notifyOperator(
  deps: NotifyOperatorDeps,
  taskId: string | null,
  event: OperatorEvent,
  notice: OperatorNotice = {},
): Promise<OperatorNoticeResult> {
  if (taskId !== null) {
    try {
      await deps.taskRepo.updateTask(taskId, { progressNote: `Operator notice: ${event}` });
    } catch (err) {
      deps.logger.error({ err, taskId, event }, 'onboarding: failed to record operator notice');
      return { recorded: false };
    }
  }
  // Detail values can carry model-supplied text, so logs and audit get the key names only
  // (review checklist: ids and counts, not content). Only typed facts are emailed.
  const detailKeys = notice.details ? Object.keys(notice.details) : [];
  deps.logger.warn(
    { taskId, event, detailKeys, hasClientId: notice.clientId !== undefined },
    'onboarding: operator notice',
  );

  if (deps.gateway) {
    const { subject, lines } = noticeText(event, notice);
    const link = deps.appOrigin?.trim();
    const emailed = await deps.gateway.sendNotification({
      notificationType: event,
      subject,
      body: [...lines, ...(link ? ['', `Console: ${link.replace(/\/+$/, '')}/`] : [])].join('\n'),
    });
    if (!emailed) {
      deps.logger.error(
        { taskId, event },
        'onboarding: the operator notice could not be sent — it is recorded on the task',
      );
    }
  }

  try {
    deps.audit?.({ type: 'onboarding.operator_notice', taskId, event, detailKeys });
  } catch (err) {
    // Best-effort: the notice is already on the task; a failed audit must not report it unrecorded.
    deps.logger.error({ err, taskId, event }, 'onboarding: operator notice audit failed — the notice is recorded on the task');
  }
  return { recorded: taskId !== null };
}
