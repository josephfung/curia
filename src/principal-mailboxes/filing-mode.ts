// Per-mailbox filing mode (#2699): whether email triage archives a handled message or leaves it
// in the inbox marked read. Stored in config-store as `ceo_inbox/filing`, a JSON object keyed by
// mailbox id: {"<mailbox id>":"archive" | "leave_in_inbox"}.
import { ADD_PRINCIPAL_MAILBOX_HINT } from './types.js';

export type FilingMode = 'archive' | 'leave_in_inbox';

/** The config-store key (namespace `ceo_inbox`, TRIAGE_NAMESPACE) that holds the per-mailbox modes. */
export const FILING_KEY = 'filing';

/** The mode a mailbox has when nothing valid is stored for it. */
export const DEFAULT_FILING_MODE: FilingMode = 'archive';

const MODES: readonly FilingMode[] = ['archive', 'leave_in_inbox'];

function isFilingMode(v: unknown): v is FilingMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

/**
 * Parse the stored `{ "<mailbox id>": "<mode>" }` JSON for one mailbox. Anything missing or
 * invalid falls back to archive (the long-standing behavior). `malformed` is true for a stored
 * value that is not that shape, or names an unknown mode for this mailbox, so the caller can warn;
 * a mailbox with no key of its own is not malformed and never reads another mailbox's mode.
 * Pure: callers log when `malformed`.
 */
export function readFilingMode(
  raw: string | null,
  mailbox: string,
): { mode: FilingMode; malformed: boolean } {
  const fallback = (malformed: boolean) => ({ mode: DEFAULT_FILING_MODE, malformed });
  if (raw === null) return fallback(false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable setting: the default mode, flagged so the caller warns (see above).
    return fallback(true);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback(true);
  if (!Object.prototype.hasOwnProperty.call(parsed, mailbox)) return fallback(false);
  const value = (parsed as Record<string, unknown>)[mailbox];
  return isFilingMode(value) ? { mode: value, malformed: false } : fallback(true);
}

/**
 * Validate a `ceo_inbox/filing` write: a JSON object keyed by live mailbox ids whose values are
 * all known modes. A bad write would otherwise be stored, ignored by the reader, and confirmed to
 * the principal as if it had taken effect. Nothing is echoed back.
 */
export function checkFilingWrite(
  raw: string,
  live: ReadonlyArray<{ id: string; label: string }>,
): { ok: true } | { ok: false; error: string } {
  if (live.length === 0) {
    return { ok: false, error: `No principal mailbox is connected yet, so there is no filing mode to set. Nothing was stored. ${ADD_PRINCIPAL_MAILBOX_HINT}` };
  }
  const shape = `Store a JSON object {"<mailbox id>":"archive" | "leave_in_inbox"}. Mailboxes: ${live.map((m) => `${m.id} (${m.label})`).join(', ')}. Nothing was stored.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `ceo_inbox/filing must be JSON (${err instanceof Error ? err.name : 'parse error'}). ${shape}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `ceo_inbox/filing must be an object keyed by mailbox id. ${shape}` };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const liveIds = new Set(live.map((m) => m.id));
  const unknown = entries.filter(([k]) => !liveIds.has(k)).map(([k]) => k);
  if (unknown.length > 0) return { ok: false, error: `Not a connected mailbox: ${unknown.join(', ')}. ${shape}` };
  const bad = entries.filter(([, v]) => !isFilingMode(v)).map(([k]) => k);
  if (bad.length > 0) return { ok: false, error: `Not a valid filing mode for: ${bad.join(', ')}. ${shape}` };
  return { ok: true };
}
