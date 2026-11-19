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
  /** Null on an install that predates the Setup page. */
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

/**
 * Save Setup page fields. The first save on a new install (phase not set and the office
 * identity not yet configured) also marks Setup in progress, so the page stays the landing
 * page until Start onboarding even after Curia's name is saved. An install that predates
 * the Setup page keeps a null phase.
 */
export async function updateSetupState(
  db: SetupStateQueryable,
  update: SetupStateUpdate,
  identityConfigured: boolean,
): Promise<SetupState> {
  const fields = (Object.keys(COLUMNS) as Array<keyof SetupStateUpdate>).filter((k) => update[k] !== undefined);
  const columns = fields.map((k) => COLUMNS[k]);
  const values = fields.map((k) => update[k]);
  const startPhase = identityConfigured ? null : 'in_progress';
  const insertColumns = ['id', 'phase', ...columns].join(', ');
  const placeholders = ['1', '$1', ...columns.map((_, i) => `$${i + 2}`)].join(', ');
  const sets = [
    ...columns.map((c, i) => `${c} = $${i + 2}`),
    // Never moves a phase that is already set: 'complete' stays complete.
    'phase = COALESCE(setup_state.phase, EXCLUDED.phase)',
    'updated_at = now()',
  ].join(', ');
  await db.query(
    `INSERT INTO setup_state (${insertColumns}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${sets}`,
    [startPhase, ...values],
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
 * the operator's (PR 2). True on a new install until Start onboarding. An install that
 * predates the Setup page (phase null, identity configured) is never in Setup, even when
 * its checklist is incomplete.
 */
export function isInSetup(state: SetupState, identityConfigured: boolean): boolean {
  if (state.phase === 'complete') return false;
  if (state.phase === 'in_progress') return true;
  return !identityConfigured;
}
