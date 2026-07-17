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

/** Build the onCorrupt callback shared by every read accessor below: logs a warning (only when a
 *  logger was supplied — the param is optional so callers/tests without a ctx.log still compile)
 *  identifying the key and a truncated snippet of the unparseable value, without dumping the
 *  full (possibly large) raw string into logs. */
function corruptionLogger(key: string, raw: string, log?: Logger): () => void {
  return () =>
    log?.warn(
      { key, rawSnippet: raw.slice(0, 120) },
      'learning-state: stored value failed to parse — treating as empty',
    );
}

export async function readCompletionCandidates(store: ConfigStore, log?: Logger): Promise<CompletionCandidateMap> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, COMPLETION_CANDIDATES_KEY);
  return parseJson<CompletionCandidateMap>(raw, raw ? corruptionLogger(COMPLETION_CANDIDATES_KEY, raw, log) : undefined) ?? {};
}
export async function writeCompletionCandidates(store: ConfigStore, map: CompletionCandidateMap): Promise<boolean> {
  return (await store.set(LEARNING_STATE_NAMESPACE, COMPLETION_CANDIDATES_KEY, JSON.stringify(map))).stored;
}

export async function readCompletionDigest(store: ConfigStore, log?: Logger): Promise<CompletionDigestMap> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, COMPLETION_DIGEST_KEY);
  return parseJson<CompletionDigestMap>(raw, raw ? corruptionLogger(COMPLETION_DIGEST_KEY, raw, log) : undefined) ?? {};
}
export async function writeCompletionDigest(store: ConfigStore, map: CompletionDigestMap): Promise<boolean> {
  return (await store.set(LEARNING_STATE_NAMESPACE, COMPLETION_DIGEST_KEY, JSON.stringify(map))).stored;
}

export async function readVoiceProposal(store: ConfigStore, log?: Logger): Promise<VoiceGuideProposal | null> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, VOICE_PROPOSAL_KEY);
  return parseJson<VoiceGuideProposal>(raw, raw ? corruptionLogger(VOICE_PROPOSAL_KEY, raw, log) : undefined);
}
export async function writeVoiceProposal(store: ConfigStore, proposal: VoiceGuideProposal | null): Promise<boolean> {
  return (await store.set(LEARNING_STATE_NAMESPACE, VOICE_PROPOSAL_KEY, JSON.stringify(proposal))).stored;
}

export async function readIdSet(store: ConfigStore, key: string, log?: Logger): Promise<Set<string>> {
  const raw = await store.get(LEARNING_STATE_NAMESPACE, key);
  const arr = parseJson<string[]>(raw, raw ? corruptionLogger(key, raw, log) : undefined);
  return new Set(Array.isArray(arr) ? arr : []);
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
