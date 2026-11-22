// registry.ts — every instance-level setting Curia stores, declared once (#2709).
//
// One module owns the key list, each key's schema, its default and a one-line purpose.
// `SettingValues` makes an undeclared key a compile error, and the store rejects one at
// runtime too. The values live in the `settings` table (migration 132) as JSONB, out of
// the knowledge graph: these are admin records. No agent tool writes settings or imports the
// store. Two tools (`setup-status`, `onboarding-progress`) see a read-only Setup projection
// through injected services.
//
// A missing row means the key's declared default applies. For all four keys the default
// is "absent", which the Setup projection reads as "not answered yet".

/** How Curia messages the principal. Mirrored by the messaging channel catalog. */
export const MESSAGING_ROUTES = ['app', 'signal', 'sms', 'slack'] as const;
export type MessagingRoute = (typeof MESSAGING_ROUTES)[number];

/** How the principal talks to Curia. Phone is not offered yet. */
export const VOICE_ROUTES = ['app', 'signal'] as const;
export type VoiceRoute = (typeof VOICE_ROUTES)[number];

/** Who Setup was for, when it was not the principal themselves. */
export interface OperatorSetting {
  name: string;
  email: string;
}

/**
 * The key list and each key's value type. Adding a key here without a `SETTINGS` entry
 * below fails to compile, and vice versa.
 */
export interface SettingValues {
  /** The operator's name and email; absent means Setup was for the principal themselves. */
  operator: OperatorSetting;
  messaging_route: MessagingRoute;
  voice_route: VoiceRoute;
  /** ISO timestamp. Absent until Setup finishes, which is what keeps Setup in progress. */
  'setup.completed_at': string;
}

export type SettingKey = keyof SettingValues;

export type SettingParse<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SettingDefinition<T> {
  /** One line: why this key exists. */
  readonly purpose: string;
  /** The value when no row is stored. `undefined` means "absent" (no default). */
  readonly default: T | undefined;
  /** Validate an unknown JSONB value and return the typed value, or why it is not one. */
  parse(raw: unknown): SettingParse<T>;
}

const MAX_OPERATOR_NAME = 200;
// Shape check only: the Setup route already validates richer input, and this also has to
// accept the values migration 132 copied from setup_state.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ok<T>(value: T): SettingParse<T> {
  return { ok: true, value };
}

function fail<T>(error: string): SettingParse<T> {
  return { ok: false, error };
}

function parseOperator(raw: unknown): SettingParse<OperatorSetting> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('expected an object with name and email');
  }
  const input = raw as Record<string, unknown>;
  const extra = Object.keys(input).filter((k) => k !== 'name' && k !== 'email');
  if (extra.length > 0) return fail(`unknown field(s): ${extra.join(', ')}`);
  const name = input['name'];
  const email = input['email'];
  if (typeof name !== 'string' || name.trim() === '') return fail('name must be a non-empty string');
  const trimmed = name.trim();
  if (trimmed.length > MAX_OPERATOR_NAME) return fail(`name must be ${MAX_OPERATOR_NAME} characters or fewer`);
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return fail('email must be an email address');
  return ok({ name: trimmed, email: email.trim().toLowerCase() });
}

function parseOneOf<T extends string>(allowed: readonly T[]): (raw: unknown) => SettingParse<T> {
  return (raw) =>
    typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
      ? ok(raw as T)
      : fail(`expected one of ${allowed.join(', ')}`);
}

function parseCompletedAt(raw: unknown): SettingParse<string> {
  if (typeof raw !== 'string') return fail('expected an ISO timestamp string');
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return fail('not a parseable timestamp');
  // Normalize to one shape: migration 132 and markSetupComplete can format differently.
  return ok(new Date(time).toISOString());
}

/**
 * The registry. Iterating `SETTINGS` is how the store knows every valid key, so a key
 * added to `SettingValues` but not here (or here but not there) is a type error.
 */
export const SETTINGS: { readonly [K in SettingKey]: SettingDefinition<SettingValues[K]> } = {
  operator: {
    purpose: 'Who Setup was for when it was not the principal — the person who runs this Curia.',
    default: undefined,
    parse: parseOperator,
  },
  messaging_route: {
    purpose: 'How Curia messages the principal: the app, Signal, SMS or Slack.',
    default: undefined,
    parse: parseOneOf(MESSAGING_ROUTES),
  },
  voice_route: {
    purpose: 'How the principal talks to Curia: the app or a Signal call.',
    default: undefined,
    parse: parseOneOf(VOICE_ROUTES),
  },
  'setup.completed_at': {
    purpose: 'When Setup finished. Absent while Setup runs, so the phase is derived, not stored.',
    default: undefined,
    parse: parseCompletedAt,
  },
};

/** Every key. The registry test pins this list, so adding one is a deliberate edit to both. */
export function settingKeys(): SettingKey[] {
  return Object.keys(SETTINGS) as SettingKey[];
}

/** A runtime key check for values that did not come from typed code (route bodies, tests). */
export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}
