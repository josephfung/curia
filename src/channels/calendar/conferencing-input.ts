// conferencing-input.ts — shared conferencing parsing for Nylas calendar writes (#2536).
//
// Nylas takes either { provider, autocreate: {} } for a new link or
// { provider, details } to attach an existing one, and its errors reveal that shape
// one rejection at a time. Checking here gives the agent one usable answer per call
// and costs no Nylas request when the input can't succeed.

type ConferencingProvider = 'Google Meet' | 'Microsoft Teams' | 'Zoom Meeting' | 'GoToMeeting' | 'WebEx';

// A Map, because the keys are model-supplied and a plain object would match "constructor".
const PROVIDER_ALIASES: ReadonlyMap<string, ConferencingProvider> = new Map([
  ['google meet', 'Google Meet'],
  ['meet', 'Google Meet'],
  ['microsoft teams', 'Microsoft Teams'],
  ['teams', 'Microsoft Teams'],
  ['zoom meeting', 'Zoom Meeting'],
  ['zoom', 'Zoom Meeting'],
  ['gotomeeting', 'GoToMeeting'],
  ['webex', 'WebEx'],
]);

const ALL_PROVIDERS = 'Google Meet, Microsoft Teams, Zoom Meeting, GoToMeeting, WebEx';

// Nylas auto-creates Google Meet and Microsoft Teams links through the calendar grant.
// Zoom needs a separate conf_grant_id, and Curia has no Zoom connection to supply one.
const AUTOCREATABLE: ReadonlySet<ConferencingProvider> = new Set(['Google Meet', 'Microsoft Teams']);

const KNOWN_KEYS = new Set(['provider', 'autocreate', 'details']);

const SHAPE_HINT = 'Use { provider, autocreate: true } for a new link or { provider, details: { url } } for an existing one.';
const NOTHING_CHANGED = 'Nothing was created or changed.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseConferencing(
  raw: unknown,
): { ok: true; conferencing: Record<string, unknown> } | { ok: false; error: string } {
  const invalid = (reason: string) => ({ ok: false as const, error: `Invalid input: ${reason} ${SHAPE_HINT}` });

  if (!isRecord(raw)) return invalid('conferencing must be an object.');

  const unknownKey = Object.keys(raw).find((key) => !KNOWN_KEYS.has(key));
  if (unknownKey !== undefined) return invalid(`conferencing has an unknown field "${unknownKey}".`);

  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') {
    return invalid(`conferencing.provider is required, one of: ${ALL_PROVIDERS}.`);
  }
  const provider = PROVIDER_ALIASES.get(raw.provider.trim().toLowerCase());
  if (provider === undefined) {
    return invalid(`conferencing.provider "${raw.provider}" is not supported. Use one of: ${ALL_PROVIDERS}.`);
  }

  const { autocreate, details } = raw;
  if (autocreate !== undefined && typeof autocreate !== 'boolean' && !isRecord(autocreate)) {
    return invalid('conferencing.autocreate must be true.');
  }
  const wantsAutocreate = autocreate !== undefined && autocreate !== false;

  if (wantsAutocreate && details !== undefined) {
    return invalid('conferencing takes autocreate or details, not both.');
  }

  if (wantsAutocreate) {
    if (provider === 'Zoom Meeting') {
      return {
        ok: false,
        error:
          `Zoom links cannot be auto-created because no Zoom account is connected. ${NOTHING_CHANGED} ` +
          'Tell the principal; if they have a Zoom link, pass it as { provider: "Zoom Meeting", details: { url } }.',
      };
    }
    if (!AUTOCREATABLE.has(provider)) {
      return {
        ok: false,
        error:
          `${provider} links cannot be auto-created; only Google Meet and Microsoft Teams can. ${NOTHING_CHANGED} ` +
          `To attach an existing link, pass { provider: "${provider}", details: { url } }.`,
      };
    }
    if (isRecord(autocreate) && Object.keys(autocreate).length > 0) {
      return invalid('conferencing.autocreate takes no settings; pass true.');
    }
    return { ok: true, conferencing: { provider, autocreate: {} } };
  }

  if (details === undefined) {
    return invalid('conferencing needs autocreate: true or details.');
  }
  if (!isRecord(details) || Object.keys(details).length === 0) {
    return invalid('conferencing.details must be an object with the meeting url.');
  }
  return { ok: true, conferencing: { provider, details } };
}
