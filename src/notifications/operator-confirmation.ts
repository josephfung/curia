// operator-confirmation.ts — when the operator's address is confirmed, and by what (#2710).
//
// Saving an operator address sends one short notice to it, because nothing else would reveal a
// mistyped address: operator notices are the only mail the operator gets, and a wrong address
// swallows them silently. The catch is that the address is often saved before Curia can send
// anything at all — "Who it's for" is the first Setup step, and a fresh install has no email
// adapter until it restarts.
//
// So the notice is *owed*, not fired and forgotten: `operator_confirmation` (ADR-067's settings
// store) records the last attempt, and anything that can deliver retries while a notice is owed.
// The status this module derives is what the console shows.
import type { Logger } from '../logger.js';
import { getSetting, getSettingRecords, setSetting, type SettingsPool } from '../settings/store.js';
import type { OperatorConfirmation, OperatorSetting } from '../settings/registry.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import { sendOperatorConfirmation } from './operator-notice.js';

/** What the console and the Setup page report about the operator's confirmation notice. */
export type OperatorConfirmationState = 'none' | 'pending' | 'sent' | 'failed';

export interface OperatorConfirmationStatus {
  state: OperatorConfirmationState;
  /** The operator address the state is about. Absent when no operator is set. */
  email?: string;
  attemptedAt?: string;
  sentAt?: string;
}

/**
 * Where the confirmation for the saved operator stands.
 *   - `none`: no operator is set, so nothing is owed.
 *   - `pending`: an operator is set and no attempt has been made for that address (a fresh
 *     Setup save, or the address changed since the last attempt). Retried automatically.
 *   - `sent`: the last attempt for this address was published for delivery.
 *   - `failed`: the last attempt for this address reached nobody. Retried automatically too —
 *     `failed` is what the console says now, not a permanent state.
 */
export function confirmationStatus(
  operator: OperatorSetting | undefined,
  confirmation: OperatorConfirmation | undefined,
): OperatorConfirmationStatus {
  if (!operator) return { state: 'none' };
  if (!confirmation || confirmation.email !== operator.email) {
    return { state: 'pending', email: operator.email };
  }
  return confirmation.sentAt !== null
    ? { state: 'sent', email: operator.email, attemptedAt: confirmation.attemptedAt, sentAt: confirmation.sentAt }
    : { state: 'failed', email: operator.email, attemptedAt: confirmation.attemptedAt };
}

/**
 * The confirmation status after a save, or a stand-in when working it out failed (#2710 review).
 * The save already committed, so a failed lookup or send must not turn it into a 500: the
 * response says `failed` (nothing claims it was sent) and the next boot or Start retries it.
 */
export async function confirmationAfterSave(
  work: () => Promise<OperatorConfirmationStatus>,
  operatorEmail: string | undefined,
  logger: Pick<Logger, 'error'>,
): Promise<OperatorConfirmationStatus> {
  try {
    return await work();
  } catch (err) {
    logger.error({ err }, 'operator confirmation: could not work out the status after a save — the save stands');
    return operatorEmail !== undefined ? { state: 'failed', email: operatorEmail } : { state: 'none' };
  }
}

/** Read both keys and derive the status. One query. */
export async function readOperatorConfirmationStatus(
  db: Parameters<typeof getSettingRecords>[0],
  logger: Pick<Logger, 'error'>,
): Promise<OperatorConfirmationStatus> {
  const records = await getSettingRecords(db, ['operator', 'operator_confirmation'], logger);
  return confirmationStatus(records.operator?.value, records.operator_confirmation?.value);
}

/**
 * The confirmation could not be delivered after all (#2710). A refusal the email adapter reports
 * while the notice is still being published already makes `sendNotification` return false, so
 * this is the backstop for a report that arrives after it returned, when `sentAt` is recorded.
 * Clearing `sentAt` puts the notice back to `failed`, which is what the console
 * shows and what the next boot or Start retries — otherwise a mistyped address reads as confirmed
 * on exactly the installs where notices never arrive.
 *
 * Only the current address's record is touched: a newer confirmation for a newer address is not
 * invalidated by a late failure report for the old one. A no-op when nothing says it was sent.
 */
export async function markOperatorConfirmationUndelivered(deps: {
  pool: SettingsPool;
  /** The address the failed notice went to. Required: without it the record cannot be matched. */
  recipient: string;
  logger: Pick<Logger, 'error'> & Pick<Logger, 'warn'>;
}): Promise<void> {
  const [operator, stored] = await Promise.all([
    getSetting(deps.pool, 'operator', deps.logger),
    getSetting(deps.pool, 'operator_confirmation', deps.logger),
  ]);
  if (!operator || !stored || stored.sentAt === null) return;
  // Only the record for the address that failed. A late failure for the previous operator address
  // must not clear the confirmation of the one that replaced it — that would cost an extra notice
  // and misreport a delivery that worked.
  if (deps.recipient.trim().toLowerCase() !== stored.email) return;
  if (stored.email !== operator.email) return;
  try {
    await setSetting(deps.pool, 'operator_confirmation', { ...stored, sentAt: null }, 'curia', deps.logger);
    deps.logger.warn(
      { attemptedAt: stored.attemptedAt },
      'operator confirmation: the notice was not delivered — marked failed so it is retried',
    );
  } catch (err) {
    // The audit row from the adapter is the durable record; failing to update the console's copy
    // of it must not throw into the notification path.
    deps.logger.error({ err }, 'operator confirmation: could not mark the notice undelivered');
  }
}

export interface PendingConfirmationDeps {
  pool: SettingsPool;
  /** The one system-notice path. Absent: nothing can be sent, so the notice stays owed. */
  gateway?: Pick<OutboundGateway, 'sendNotification'>;
  /** Whether a channel adapter that delivers notifications is subscribed right now. */
  canDeliver?: () => boolean;
  appOrigin?: string;
  logger: Logger;
}

/**
 * Send the confirmation notice while one is owed, and record the attempt. Idempotent: a status of
 * `sent` for the current address sends nothing. Returns the status afterwards.
 *
 * Called where delivery can happen rather than where the address was saved: at boot (after the
 * email adapters start) and on Start onboarding, plus immediately from the console's own Operator
 * page, where an attempt gives the operator feedback in the moment.
 */
export async function sendPendingOperatorConfirmation(
  deps: PendingConfirmationDeps,
): Promise<OperatorConfirmationStatus> {
  const operator = await getSetting(deps.pool, 'operator', deps.logger);
  const stored = await getSetting(deps.pool, 'operator_confirmation', deps.logger);
  const before = confirmationStatus(operator, stored);
  if (before.state !== 'pending' && before.state !== 'failed') return before;
  if (!operator) return before;

  // Nothing can deliver it yet. Record nothing: the notice stays owed and retried, and the
  // console says "pending" rather than inventing a failure.
  if (!deps.gateway || (deps.canDeliver && !deps.canDeliver())) {
    deps.logger.info(
      { state: before.state },
      'operator confirmation: nothing can deliver it yet — the notice stays owed',
    );
    return before;
  }

  const sent = await sendOperatorConfirmation(
    {
      gateway: deps.gateway,
      ...(deps.appOrigin ? { appOrigin: deps.appOrigin } : {}),
      logger: deps.logger,
    },
    operator,
  );

  const attemptedAt = new Date().toISOString();
  const next: OperatorConfirmation = {
    email: operator.email,
    attemptedAt,
    sentAt: sent ? attemptedAt : null,
  };
  try {
    await setSetting(deps.pool, 'operator_confirmation', next, 'curia', deps.logger);
  } catch (err) {
    // The notice went out (or did not); failing to record it must not throw into a boot path.
    // The next attempt repeats the notice, which is the safe direction.
    deps.logger.error({ err }, 'operator confirmation: could not record the attempt');
  }
  return confirmationStatus(operator, next);
}
