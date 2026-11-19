// setup-state.ts — what the console's Setup page stores beyond the principal and the
// office identity (#2358): who Setup is for, the operator's details, the chosen
// messaging and voice routes, and whether Setup is still running.

export type SetupFor = 'self' | 'other';
export type MessagingRoute = 'app' | 'signal' | 'sms' | 'slack';
export type VoiceRoute = 'app' | 'signal';
export type SetupPhaseValue = 'in_progress' | 'complete';

export const MESSAGING_ROUTES: readonly MessagingRoute[] = ['app', 'signal', 'sms', 'slack'];
export const VOICE_ROUTES: readonly VoiceRoute[] = ['app', 'signal'];

export interface SetupState {
  /** Null until the first save on a new install. Migration 130 marks older installs complete. */
  phase: SetupPhaseValue | null;
  setupFor: SetupFor | null;
  operatorName: string | null;
  operatorEmail: string | null;
  messagingRoute: MessagingRoute | null;
  voiceRoute: VoiceRoute | null;
  completedAt: Date | null;
}

/** The fields the Setup page writes. Undefined leaves a field as it is; null clears it. */
export interface SetupStateUpdate {
  setupFor?: SetupFor | null;
  operatorName?: string | null;
  operatorEmail?: string | null;
  messagingRoute?: MessagingRoute | null;
  voiceRoute?: VoiceRoute | null;
}

export interface SetupStateQueryable {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[] }>;
}

export const EMPTY_SETUP_STATE: SetupState = {
  phase: null,
  setupFor: null,
  operatorName: null,
  operatorEmail: null,
  messagingRoute: null,
  voiceRoute: null,
  completedAt: null,
};

interface SetupStateRow extends Record<string, unknown> {
  phase: SetupPhaseValue | null;
  setup_for: SetupFor | null;
  operator_name: string | null;
  operator_email: string | null;
  messaging_route: MessagingRoute | null;
  voice_route: VoiceRoute | null;
  completed_at: Date | null;
}

export async function readSetupState(db: SetupStateQueryable): Promise<SetupState> {
  const result = await db.query<SetupStateRow>(
    `SELECT phase, setup_for, operator_name, operator_email, messaging_route, voice_route, completed_at
     FROM setup_state WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) return EMPTY_SETUP_STATE;
  return {
    phase: row.phase,
    setupFor: row.setup_for,
    operatorName: row.operator_name,
    operatorEmail: row.operator_email,
    messagingRoute: row.messaging_route,
    voiceRoute: row.voice_route,
    completedAt: row.completed_at,
  };
}

// Column per update field. The names are fixed here, never taken from input.
const COLUMNS: Record<keyof SetupStateUpdate, string> = {
  setupFor: 'setup_for',
  operatorName: 'operator_name',
  operatorEmail: 'operator_email',
  messagingRoute: 'messaging_route',
  voiceRoute: 'voice_route',
};

/** Save Setup page fields. The first save on a new install creates the row, in progress. */
export async function updateSetupState(db: SetupStateQueryable, update: SetupStateUpdate): Promise<SetupState> {
  const fields = (Object.keys(COLUMNS) as Array<keyof SetupStateUpdate>).filter((k) => update[k] !== undefined);
  const columns = fields.map((k) => COLUMNS[k]);
  const values = fields.map((k) => update[k]);
  const insertColumns = ['id', 'phase', ...columns].join(', ');
  const placeholders = ['1', "'in_progress'", ...columns.map((_, i) => `$${i + 1}`)].join(', ');
  // The phase is never changed here: 'complete' stays complete.
  const sets = [...columns.map((c, i) => `${c} = $${i + 1}`), 'updated_at = now()'].join(', ');
  await db.query(
    `INSERT INTO setup_state (${insertColumns}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${sets}`,
    values,
  );
  return readSetupState(db);
}

/**
 * The Setup page opened (#2358, PR 4): Setup has started, so web chat goes to the setup guide
 * from the first message. Creates the row as in_progress, but only on a database that has
 * nothing set up yet: no principal and no saved office identity, the same test migration 130
 * used to mark older installs complete. A database whose principal a script created after
 * the migrations (the KG demo, scenario runs, a data-only restore) has no row and must keep
 * its web chat with the coordinator even when the console is opened on it. A row already
 * there (in progress or complete) is left exactly as it is. Idempotent.
 */
export async function startSetup(db: SetupStateQueryable): Promise<SetupState> {
  await db.query(
    `INSERT INTO setup_state (id, phase)
     SELECT 1, 'in_progress'
     WHERE NOT EXISTS (SELECT 1 FROM office_identity_versions WHERE changed_by IN ('wizard', 'api'))
       AND NOT EXISTS (SELECT 1 FROM contacts WHERE system_role = 'principal')
     ON CONFLICT (id) DO NOTHING`,
  );
  return readSetupState(db);
}

/** Start onboarding: Setup is over. Idempotent. */
export async function markSetupComplete(db: SetupStateQueryable): Promise<void> {
  await db.query(
    `INSERT INTO setup_state (id, phase, completed_at) VALUES (1, 'complete', now())
     ON CONFLICT (id) DO UPDATE SET phase = 'complete',
       completed_at = COALESCE(setup_state.completed_at, now()), updated_at = now()`,
  );
}

/**
 * Whether the console should show the Setup page and the server should treat web chat as
 * the operator's (PR 2): from a new install's first load until Start onboarding. Migration
 * 130 marked installs that predate the Setup page complete, so they never are.
 */
export function isInSetup(state: SetupState): boolean {
  return state.phase !== 'complete';
}

/**
 * Whether web chat goes to the setup guide (#2358): only once the phase reads in_progress,
 * which the Setup page sets when it opens on a database with nothing set up (startSetup) or
 * when it saves something. Stricter than isInSetup on purpose: a database whose principal was
 * created by a script after migrations (tests, scenario runs) has no row, and its web chat
 * stays with the coordinator, even when the console is opened on it.
 */
export function routesWebChatToSetupGuide(phase: SetupState['phase'] | string | null): boolean {
  return phase === 'in_progress';
}
