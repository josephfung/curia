// Config-store JSON accessors for the email-observation learning subsystem (#1438).
//
// The queue/status/guard machine-state that used to ride inside OKF markdown doc bodies
// (completion candidates, digest items, the voice proposal, the matched/asked guard sets) now
// lives here as whole-object JSON values under the `ceo_inbox` namespace. Removal = writing the
// map without the entry (no per-item tombstones, no regex parse). Prose evidence
// (pending-diffs.md), draft snapshots, and shadow docs stay in OKF (see ADR-029).

import type { ConfigStore } from '../../src/memory/config-store.js';
import type { Logger } from '../../src/logger.js';
import type { MatchConfidence } from './sent-observe-match.js';

/** Same namespace as the watermark/idle-backoff/checkpoint/dismiss-cooldown keys. */
export const LEARNING_STATE_NAMESPACE = 'ceo_inbox';

export const COMPLETION_CANDIDATES_KEY = 'sent_observe.completion_candidates';
export const COMPLETION_DIGEST_KEY = 'sent_observe.completion_digest';
export const VOICE_PROPOSAL_KEY = 'voice_learn.proposal';
export const MATCHED_DRAFT_IDS_KEY = 'sent_observe.matched_draft_ids';
export const ASKED_TASK_IDS_KEY = 'sent_observe.asked_task_ids';

/** A task-completion candidate queued by sent-observe, consumed by task-completion-from-sent. */
export interface CompletionCandidate {
  messageId: string;
  confidence: MatchConfidence;
  reason: string;
  sentAt: string;
  subject: string;
  recipients: string[];
  taskTitle: string;
}
/** Keyed by taskId — one open task has at most one live candidate, so re-adds are idempotent. */
export type CompletionCandidateMap = Record<string, CompletionCandidate>;

/** An undo/confirm item shown in the learning digest. `taskId` is carried in the value so the
 *  render helpers (which take a flat array) keep emitting the reply-command per item unchanged. */
export interface CompletionDigestItem {
  kind: 'undo' | 'confirm';
  taskId: string;
  taskTitle: string;
  note: string;
}
export type CompletionDigestMap = Record<string, CompletionDigestItem>;

export interface VoiceGuideProposal {
  status: string;
  generatedAt: string;
  guide: string;
}

/** Parse a stored JSON value, treating unset/garbage as absent — data loss (a dropped item) is
 *  worse than over-retention, and a parse throw must never escape into a skill failure. A
 *  `null`/empty `raw` is NOT corruption (just "never written") and does not invoke `onCorrupt`;
 *  only an actual JSON.parse failure on a non-empty value does — that's a genuinely corrupt
 *  stored value silently degrading to empty, which callers should be able to observe/log. */
function parseJson<T>(raw: string | null, onCorrupt?: () => void): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    onCorrupt?.();
    return null;
  }
}

/** Top-level shape guard: distinguishes "a JSON object" from an array/primitive that parsed fine
 *  but is the wrong top-level shape (e.g. a map key that somehow got a `"[]"` written to it). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Per-ENTRY validators for the map stores. A structurally-valid map can still hold a malformed
// value — `{"t1": {}}` or `{"t1": null}` — which is not merely wrong, it CRASHES the consumer:
// task-completion dereferences `candidate.recipients[0]`, and renderCompletionSection dereferences
// `item.kind`. The `execute()` wrapper catches the throw, but the whole run then fails on every
// invocation while the bad entry persists. These validate only the fields actually consumed and let
// the readers DROP a bad entry (keeping the good ones) at the read boundary, so one corrupt/skewed
// entry can't break the run — and the next write persists the cleaned map (self-healing). This is
// the persistence-boundary validation the repo guideline requires before casting to a typed shape.

function isCompletionCandidate(v: unknown): v is CompletionCandidate {
  return (
    isPlainObject(v) &&
    typeof v.messageId === 'string' &&
    (v.confidence === 'high' || v.confidence === 'low') &&
    typeof v.reason === 'string' &&
    typeof v.sentAt === 'string' &&
    typeof v.subject === 'string' &&
    Array.isArray(v.recipients) &&
    v.recipients.every((r) => typeof r === 'string') &&
    typeof v.taskTitle === 'string'
  );
}

function isCompletionDigestItem(v: unknown): v is CompletionDigestItem {
  return (
    isPlainObject(v) &&
    (v.kind === 'undo' || v.kind === 'confirm') &&
    typeof v.taskId === 'string' &&
    typeof v.taskTitle === 'string' &&
    typeof v.note === 'string'
  );
}

/** Keep only entries whose value passes `isValid`; drop the rest, logging a PII-safe count (never
 *  the dropped content) when anything was dropped. `parsed` is a confirmed plain object. */
function filterValidEntries<V>(
  parsed: Record<string, unknown>,
  key: string,
  isValid: (v: unknown) => v is V,
  log?: Logger,
): Record<string, V> {
  const out: Record<string, V> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (isValid(v)) out[k] = v;
    else dropped += 1;
  }
  if (dropped > 0) {
    log?.warn(
      { key, dropped },
      'learning-state: dropped malformed entries from a stored map — treating them as absent',
    );
  }
  return out;
}

/** Build the onCorrupt callback shared by every read accessor below: logs a warning (only when a
 *  logger was supplied — the param is optional so callers/tests without a ctx.log still compile)
 *  identifying the key and the raw value's length, without dumping the value's actual content —
 *  which can carry PII (recipient addresses, subjects, task titles, proposal text) — into logs. */
function corruptionLogger(key: string, raw: string, log?: Logger): () => void {
  return () =>
    log?.warn(
      { key, rawLength: raw.length },
      'learning-state: stored value failed to parse — treating as empty',
    );
}

export async function readCompletionCandidates(store: ConfigStore, log?: Logger): Promise<CompletionCandidateMap> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, COMPLETION_CANDIDATES_KEY);
  const parsed = parseJson<unknown>(raw, raw ? corruptionLogger(COMPLETION_CANDIDATES_KEY, raw, log) : undefined);
  if (parsed === null) return {};
  if (!isPlainObject(parsed)) {
    corruptionLogger(COMPLETION_CANDIDATES_KEY, raw!, log)();
    return {};
  }
  return filterValidEntries(parsed, COMPLETION_CANDIDATES_KEY, isCompletionCandidate, log);
}
export async function writeCompletionCandidates(store: ConfigStore, map: CompletionCandidateMap): Promise<boolean> {
  return (await store.set(LEARNING_STATE_NAMESPACE, COMPLETION_CANDIDATES_KEY, JSON.stringify(map))).stored;
}

export async function readCompletionDigest(store: ConfigStore, log?: Logger): Promise<CompletionDigestMap> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, COMPLETION_DIGEST_KEY);
  const parsed = parseJson<unknown>(raw, raw ? corruptionLogger(COMPLETION_DIGEST_KEY, raw, log) : undefined);
  if (parsed === null) return {};
  if (!isPlainObject(parsed)) {
    corruptionLogger(COMPLETION_DIGEST_KEY, raw!, log)();
    return {};
  }
  return filterValidEntries(parsed, COMPLETION_DIGEST_KEY, isCompletionDigestItem, log);
}
export async function writeCompletionDigest(store: ConfigStore, map: CompletionDigestMap): Promise<boolean> {
  return (await store.set(LEARNING_STATE_NAMESPACE, COMPLETION_DIGEST_KEY, JSON.stringify(map))).stored;
}

export async function readVoiceProposal(store: ConfigStore, log?: Logger): Promise<VoiceGuideProposal | null> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, VOICE_PROPOSAL_KEY);
  const parsed = parseJson<unknown>(raw, raw ? corruptionLogger(VOICE_PROPOSAL_KEY, raw, log) : undefined);
  if (parsed === null) return null;
  // Validate every field of the (small, fixed) proposal contract, not just the consumed ones: our
  // writer always emits all three, so requiring generatedAt never drops a real proposal, and a
  // proposal missing it is genuinely malformed — dropping it (voice-learn re-proposes next run) is
  // safer than casting an incomplete object.
  if (
    !isPlainObject(parsed) ||
    typeof parsed.status !== 'string' ||
    typeof parsed.generatedAt !== 'string' ||
    typeof parsed.guide !== 'string'
  ) {
    corruptionLogger(VOICE_PROPOSAL_KEY, raw!, log)();
    return null;
  }
  return parsed as unknown as VoiceGuideProposal;
}
export async function writeVoiceProposal(store: ConfigStore, proposal: VoiceGuideProposal | null): Promise<boolean> {
  return (await store.set(LEARNING_STATE_NAMESPACE, VOICE_PROPOSAL_KEY, JSON.stringify(proposal))).stored;
}

export async function readIdSet(store: ConfigStore, key: string, log?: Logger): Promise<Set<string>> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, key);
  const parsed = parseJson<unknown>(raw, raw ? corruptionLogger(key, raw, log) : undefined);
  if (parsed !== null && !Array.isArray(parsed)) {
    // Parsed fine but the wrong top-level shape (e.g. a map object stored under an id-set key) —
    // route through the same corruption logger so this isn't a silent empty-set degrade.
    corruptionLogger(key, raw!, log)();
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set(); // null/unset — absence, not corruption
  // Validate every MEMBER is a string, not just that the top level is an array. A non-string member
  // (e.g. `[42]` or `["t1", null]`) wouldn't throw — it'd silently sit in the Set and bypass the
  // guard, since `set.has("42")` never matches the numeric `42`. Drop non-strings, logging a
  // PII-safe count, so a corrupt/skewed member can't quietly defeat an idempotency guard.
  const valid = parsed.filter((v): v is string => typeof v === 'string');
  if (valid.length !== parsed.length) {
    log?.warn(
      { key, dropped: parsed.length - valid.length },
      'learning-state: dropped non-string entries from a stored id set — treating them as absent',
    );
  }
  return new Set(valid);
}
export async function writeIdSet(store: ConfigStore, key: string, ids: Set<string>): Promise<boolean> {
  return (await store.set(LEARNING_STATE_NAMESPACE, key, JSON.stringify([...ids]))).stored;
}

/** Flatten the digest map to the array the render helpers consume, preserving insertion order. */
export function digestMapToItems(map: CompletionDigestMap): CompletionDigestItem[] {
  return Object.values(map);
}

/** Human note for an auto-completed task's undo affordance. Verbatim to the pre-migration
 *  formatUndoNote copy so the digest UX is byte-identical. */
export function composeUndoNote(params: { taskTitle: string; recipient: string; sentAt: string }): string {
  const when = params.sentAt ? ` (${params.sentAt.slice(0, 10)})` : '';
  return `Marked *${params.taskTitle}* done — you emailed ${params.recipient}${when}. Undo?`;
}

/** Human note for a confirm-in-digest item. Verbatim to the pre-migration formatConfirmNote copy. */
export function composeConfirmNote(params: { taskTitle: string; recipient: string }): string {
  return `Did emailing ${params.recipient} complete *${params.taskTitle}*?`;
}
