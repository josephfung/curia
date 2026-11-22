// setup-settings.ts — Setup's view of the settings store (#2709).
//
// Setup used to have its own single-row table, setup_state (migration 130, #2358; removed by
// migration 132). It is gone: what Setup collects is now keys in the settings store, alongside
// every other admin setting. This module is the one place that turns those keys into the shape
// the console, the checklist and onboarding already consume, so the console API keeps its
// response.
//
// Two fields are derived rather than stored:
//   - setupFor: an operator value means "someone else"; absent means "myself".
//   - phase: complete once setup.completed_at is set, in progress until then. Setup has
//     started from the moment the console opens it, so there is no separate "not started".
//
// `completedOnPage` separates a Setup finished on the Setup page (before or after migration
// 132) from one that migration 132 marked complete for an install that predates the page
// (PRE_SETUP_PAGE_ACTOR). Onboarding uses it: the prior-tasks
// signal counts every task on a pre-Setup install, and the dashboard alert is for the page.

import type { Logger } from '../logger.js';
import {
  getSetting,
  getSettingRecords,
  setSettingIfAbsent,
  writeSettings,
  type SettingsChange,
  type SettingsPool,
  type SettingsQueryable,
} from '../settings/store.js';
import { MESSAGING_ROUTES, VOICE_ROUTES, type MessagingRoute, type VoiceRoute } from '../settings/registry.js';

export { MESSAGING_ROUTES, VOICE_ROUTES };
export type { MessagingRoute, VoiceRoute };

export type SetupFor = 'self' | 'other';
export type SetupPhaseValue = 'in_progress' | 'complete';

/**
 * The `updated_by` migration 132 writes on `setup.completed_at` only for an install that
 * predates the Setup page (no completion time to copy). A Setup the page finished before the
 * upgrade is copied under the plain `migration:132` actor and still counts as a page
 * completion. A test pins this value; the migration SQL has the same literal.
 */
export const PRE_SETUP_PAGE_ACTOR = 'migration:132:pre-setup-page';

export interface SetupState {
  /** Derived from setup.completed_at, never stored as its own value. */
  phase: SetupPhaseValue;
  /** Derived from the operator value: present means 'other', absent means 'self'. */
  setupFor: SetupFor;
  operatorName: string | null;
  operatorEmail: string | null;
  messagingRoute: MessagingRoute | null;
  voiceRoute: VoiceRoute | null;
  /** When Setup finished, or null while it runs. */
  completedAt: Date | null;
  /**
   * True when the Setup page finished Setup (before or after migration 132); false while Setup
   * runs and when migration 132 marked an install that predates the page complete.
   */
  completedOnPage: boolean;
}

/** The fields the Setup page writes. Undefined leaves a field as it is; null clears it. */
export interface SetupStateUpdate {
  setupFor?: SetupFor;
  operatorName?: string | null;
  operatorEmail?: string | null;
  messagingRoute?: MessagingRoute | null;
  voiceRoute?: VoiceRoute | null;
}

/** Where a Setup write came from, for settings_history: an actor and where to log a bad read. */
export interface SetupWriteOptions {
  updatedBy: string;
  logger: Pick<Logger, 'error'>;
}

/** A combination of Setup fields that is valid on its own but not as a whole. */
export class SetupSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupSettingsError';
  }
}

/** A fresh install that has saved nothing: in Setup, for the principal themselves. */
export const EMPTY_SETUP_STATE: SetupState = {
  phase: 'in_progress',
  setupFor: 'self',
  operatorName: null,
  operatorEmail: null,
  messagingRoute: null,
  voiceRoute: null,
  completedAt: null,
  completedOnPage: false,
};

const SETUP_KEYS = ['operator', 'messaging_route', 'voice_route', 'setup.completed_at'] as const;

/** The four Setup keys, validated, as the console sees them. */
export async function readSetupState(
  db: SettingsQueryable,
  logger: Pick<Logger, 'error'>,
): Promise<SetupState> {
  const records = await getSettingRecords(db, SETUP_KEYS, logger);
  const operator = records.operator?.value;
  const completed = records['setup.completed_at'];
  return {
    phase: completed ? 'complete' : 'in_progress',
    setupFor: operator ? 'other' : 'self',
    operatorName: operator?.name ?? null,
    operatorEmail: operator?.email ?? null,
    messagingRoute: records.messaging_route?.value ?? null,
    voiceRoute: records.voice_route?.value ?? null,
    completedAt: completed ? new Date(completed.value) : null,
    completedOnPage: completed !== undefined && completed.updatedBy !== PRE_SETUP_PAGE_ACTOR,
  };
}

/** Just the derived phase, for web-chat routing, which has no use for the other keys. */
export async function readSetupPhase(
  db: SettingsQueryable,
  logger: Pick<Logger, 'error'>,
): Promise<SetupPhaseValue> {
  return (await getSetting(db, 'setup.completed_at', logger)) ? 'complete' : 'in_progress';
}

/**
 * Save the Setup page's fields. The operator's name and email are one value: both together
 * save "someone else", both cleared mean "myself", and one without the other is refused.
 * The phase never reopens: a completed Setup stays complete. Returns the state afterwards.
 */
export async function updateSetupState(
  pool: SettingsPool,
  update: SetupStateUpdate,
  options: SetupWriteOptions,
): Promise<SetupState> {
  const current = await readSetupState(pool, options.logger);
  const changes: SettingsChange[] = [];

  const nameGiven = update.operatorName !== undefined;
  const emailGiven = update.operatorEmail !== undefined;
  let operator: { name: string; email: string } | null | undefined;

  if (update.setupFor === 'self') {
    if ((nameGiven && update.operatorName) || (emailGiven && update.operatorEmail)) {
      throw new SetupSettingsError("Myself and the operator's details cannot be saved together.");
    }
    operator = null;
  } else if (update.setupFor === 'other') {
    const name = nameGiven ? update.operatorName : current.operatorName;
    const email = emailGiven ? update.operatorEmail : current.operatorEmail;
    if (!name || !email) throw new SetupSettingsError("Someone else needs the operator's name and email.");
    operator = { name, email };
  } else if (nameGiven || emailGiven) {
    if (nameGiven !== emailGiven) {
      throw new SetupSettingsError("Send the operator's name and email together.");
    }
    const nameBlank = (update.operatorName ?? '') === '';
    const emailBlank = (update.operatorEmail ?? '') === '';
    // Both blank clears ("myself"); both filled sets. A half-blank pair is neither, and
    // silently clearing the operator would flip Setup to "myself" with no error.
    if (nameBlank !== emailBlank) {
      throw new SetupSettingsError("Send both the operator's name and email, or clear both.");
    }
    operator = nameBlank
      ? null
      : { name: update.operatorName as string, email: update.operatorEmail as string };
  }
  if (operator !== undefined) {
    changes.push(operator === null ? { key: 'operator', value: null } : { key: 'operator', value: operator });
  }

  if (update.messagingRoute !== undefined) {
    changes.push(
      update.messagingRoute === null
        ? { key: 'messaging_route', value: null }
        : { key: 'messaging_route', value: update.messagingRoute },
    );
  }
  if (update.voiceRoute !== undefined) {
    changes.push(
      update.voiceRoute === null
        ? { key: 'voice_route', value: null }
        : { key: 'voice_route', value: update.voiceRoute },
    );
  }

  // A body of only nulls that were already absent writes nothing, but still answers with
  // the state the console should show.
  if (changes.length > 0) await writeSettings(pool, changes, options.updatedBy, options.logger);
  return readSetupState(pool, options.logger);
}

/**
 * Setup is finished (Start onboarding or Not right now; POST /api/setup/complete). The check
 * and the write share one locked transaction, so concurrent calls keep the first completion
 * time. Idempotent.
 */
export async function markSetupComplete(pool: SettingsPool, options: SetupWriteOptions): Promise<void> {
  await setSettingIfAbsent(
    pool,
    'setup.completed_at',
    new Date().toISOString(),
    options.updatedBy,
    options.logger,
  );
}

/**
 * Whether the console should show the Setup page and the server should treat web chat as the
 * operator's (PR 2): until Setup is finished. Installs that predate the Setup page are marked
 * complete by migration 132, so they never are.
 */
export function isInSetup(phase: SetupPhaseValue): boolean {
  return phase !== 'complete';
}
