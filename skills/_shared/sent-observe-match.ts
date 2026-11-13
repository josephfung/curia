// Pure matching helpers for ceo-inbox-sent-observe (#1422).
// Kept free of I/O so unit tests can cover draft-match and task-match heuristics.

import type { PrincipalSendEntry } from '../../src/skills/principal-send/send-ledger.js';
import { recordBelongsTo, type MailboxStateScope } from './mailbox-state.js';

export interface SentMessageLike {
  id: string;
  threadId: string;
  subject: string;
  to: Array<{ email: string }>;
  cc: Array<{ email: string }>;
  /** Unix seconds. */
  date: number;
  snippet?: string;
  body?: string;
}

export interface DraftSnapshotLike {
  draftId: string;
  threadId: string;
  subject: string;
  recipients: {
    to: Array<{ email: string }>;
    cc?: Array<{ email: string }>;
  };
  body: string;
  /** ISO timestamp when Curia captured the draft. */
  createdAt: string;
  /** The mailbox the draft was created in (#2475). Absent on a snapshot written before the registry. */
  mailbox?: string;
}

export interface TaskMatchCandidate {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  priority: number;
}

export interface DraftMatch {
  messageId: string;
  draftId: string;
  threadId: string;
  draftBody: string;
  sentSubject: string;
  sentRecipients: string[];
  sentAt: string;
}

/** Match strength for a sent-mail → task completion candidate. The single confidence vocabulary
 *  shared by matchTasksToSent, the completion-candidate block format, and the parser. */
export type MatchConfidence = 'high' | 'low';

export interface TaskMatch {
  messageId: string;
  taskId: string;
  confidence: MatchConfidence;
  reason: string;
  sentSubject: string;
  sentRecipients: string[];
  sentAt: string;
  taskTitle: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function recipientSet(msg: {
  to: Array<{ email: string }>;
  cc?: Array<{ email: string }>;
}): Set<string> {
  const set = new Set<string>();
  for (const p of msg.to) set.add(normalizeEmail(p.email));
  for (const p of msg.cc ?? []) set.add(normalizeEmail(p.email));
  return set;
}

function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd|fw):\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function subjectSimilar(a: string, b: string): boolean {
  const na = normalizeSubject(a);
  const nb = normalizeSubject(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const e of a) if (b.has(e)) n += 1;
  return n;
}

/** Tokenize for lightweight semantic overlap (no embeddings). */
export function tokenize(text: string): Set<string> {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with',
    'is', 'are', 'was', 'be', 'this', 'that', 'it', 'at', 'by', 'from',
    'you', 'your', 'me', 'my', 'we', 'our', 'please', 'thanks', 'thank',
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9@.\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !stop.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Match a sent message to a Curia draft snapshot.
 * Prefer thread_id; fall back to recipient overlap + subject + send-after-draft.
 */
export function matchDraftToSent(
  sent: SentMessageLike,
  snapshots: DraftSnapshotLike[],
  alreadyMatchedDraftIds: Set<string> = new Set(),
): DraftMatch | null {
  const sentRecipients = recipientSet(sent);
  const sentAtIso = new Date(sent.date * 1000).toISOString();
  let best: DraftMatch | null = null;
  // Preference ordering: thread+recipient beats thread-only beats recipient+subject. Once we
  // hold a thread hit, a later recipient+subject candidate must not replace it.
  let bestIsThreadHit = false;

  for (const snap of snapshots) {
    if (alreadyMatchedDraftIds.has(snap.draftId)) continue;

    const draftCreatedMs = Date.parse(snap.createdAt);
    // Sent must not precede draft capture (allow 2 min clock skew).
    if (Number.isFinite(draftCreatedMs) && sent.date * 1000 + 120_000 < draftCreatedMs) {
      continue;
    }

    const draftRecipients = recipientSet({
      to: snap.recipients.to,
      cc: snap.recipients.cc,
    });
    const overlap = overlapCount(sentRecipients, draftRecipients);
    const threadHit =
      Boolean(sent.threadId) &&
      Boolean(snap.threadId) &&
      sent.threadId === snap.threadId;

    const common = {
      messageId: sent.id,
      draftId: snap.draftId,
      draftBody: snap.body,
      sentSubject: sent.subject,
      sentRecipients: [...sentRecipients],
      sentAt: sentAtIso,
    };

    // Best possible: same thread AND a shared recipient — return immediately.
    if (threadHit && overlap >= 1) {
      return { ...common, threadId: sent.threadId };
    }

    // Thread-only: strong; keep scanning in case a thread+recipient hit appears.
    if (threadHit) {
      best = { ...common, threadId: sent.threadId };
      bestIsThreadHit = true;
      continue;
    }

    // Weakest accepted: shared recipient + similar subject. Only fills in when no thread match yet.
    if (overlap >= 1 && subjectSimilar(sent.subject, snap.subject) && !bestIsThreadHit) {
      best = { ...common, threadId: sent.threadId || snap.threadId };
    }
  }

  return best;
}

/**
 * Match a sent message to open principal tasks.
 * High confidence: recipient email appears in title/description AND subject/body token overlap ≥ 0.25.
 * Low confidence: subject/body token overlap ≥ 0.35 alone, or recipient mentioned without strong tokens.
 */
export function matchTasksToSent(
  sent: SentMessageLike,
  tasks: TaskMatchCandidate[],
  alreadyAskedTaskIds: Set<string> = new Set(),
): TaskMatch[] {
  const sentRecipients = [...recipientSet(sent)];
  const sentAtIso = new Date(sent.date * 1000).toISOString();
  const sentText = [sent.subject, sent.snippet ?? '', sent.body ?? ''].join(' ');
  const sentTokens = tokenize(sentText);
  const matches: TaskMatch[] = [];

  for (const task of tasks) {
    if (alreadyAskedTaskIds.has(task.id)) continue;

    const taskText = `${task.title}\n${task.description ?? ''}`;
    const taskLower = taskText.toLowerCase();
    const taskTokens = tokenize(taskText);
    const recipientHit = sentRecipients.some((email) => {
      const local = email.split('@')[0] ?? email;
      // Match the local-part as a whole token, not a substring — otherwise
      // `ann@example.com` "matches" the word "annual" and can push an unrelated
      // task to high confidence (and possibly auto-completion).
      return taskLower.includes(email) || (local.length >= 3 && taskTokens.has(local));
    });
    const overlap = jaccard(sentTokens, tokenize(taskText));

    if (recipientHit && overlap >= 0.2) {
      matches.push({
        messageId: sent.id,
        taskId: task.id,
        confidence: 'high',
        reason: 'recipient+semantic',
        sentSubject: sent.subject,
        sentRecipients,
        sentAt: sentAtIso,
        taskTitle: task.title,
      });
    } else if (overlap >= 0.35) {
      matches.push({
        messageId: sent.id,
        taskId: task.id,
        confidence: 'low',
        reason: 'semantic',
        sentSubject: sent.subject,
        sentRecipients,
        sentAt: sentAtIso,
        taskTitle: task.title,
      });
    } else if (recipientHit && subjectSimilar(sent.subject, task.title)) {
      matches.push({
        messageId: sent.id,
        taskId: task.id,
        confidence: 'low',
        reason: 'recipient+subject',
        sentSubject: sent.subject,
        sentRecipients,
        sentAt: sentAtIso,
        taskTitle: task.title,
      });
    }
  }

  // Prefer high-confidence; at most one match per task.
  matches.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1));
  const seen = new Set<string>();
  return matches.filter((m) => {
    if (seen.has(m.taskId)) return false;
    seen.add(m.taskId);
    return true;
  });
}

/** How long after a ledger entry's `at` a same-thread, same-recipient SENT message still counts as
 *  Curia's send when the entry has no message id (the id write after a send can be lost). */
export const CURIA_SEND_WINDOW_SEC = 600;

/**
 * True when a SENT message is one Curia sent from the principal's mailbox (#2474), so it must not
 * be learned as the principal's writing. Matches on the ledger's message id, or — for an entry whose
 * id was never recorded — the same thread, an intersecting recipient set (case-insensitive) and a
 * send landing within `windowSec` after the entry's `at`. A principal reply on the same thread an
 * hour later is outside the window and still counts as theirs. The fallback skips `held` entries.
 *
 * With a `scope` only that mailbox's entries count (#2475): a send recorded for another mailbox
 * never claims this mailbox's message, and a legacy entry with no mailbox claims the migrated
 * mailbox's messages only. Without a scope every entry counts (single global scope).
 */
export function isCuriaSend(
  msg: { id: string; threadId: string; to: Array<{ email: string }>; cc: Array<{ email: string }>; date: number },
  entries: readonly PrincipalSendEntry[],
  scope?: MailboxStateScope,
  windowSec: number = CURIA_SEND_WINDOW_SEC,
): boolean {
  let msgRecipients: Set<string> | null = null;
  for (const entry of entries) {
    if (scope && !recordBelongsTo(scope, entry.mailbox)) continue;
    if (entry.messageId !== undefined && entry.messageId === msg.id) return true;
    // Only an attempt that went (or may have gone) out can claim a message by thread and time. A
    // held entry sent nothing, so the principal's own reply after it is theirs (#2474 PR 2).
    if (entry.outcome !== 'sending' && entry.outcome !== 'sent') continue;
    if (!msg.threadId || entry.threadId !== msg.threadId) continue;
    // msg.date is Unix seconds (floored by the provider); entry.at is ISO with milliseconds, so
    // floor it too or a send in the same second as the marker would look like it came first.
    const atMs = Date.parse(entry.at);
    if (!Number.isFinite(atMs)) continue;
    const atSec = Math.floor(atMs / 1000);
    if (msg.date < atSec || msg.date > atSec + windowSec) continue;
    msgRecipients ??= recipientSet(msg);
    if (entry.recipients.some((r) => msgRecipients!.has(normalizeEmail(r)))) return true;
  }
  return false;
}

/** Format a (draft, sent) pair for the rolling evidence doc. */
export function formatDiffBlock(match: DraftMatch, sentBody: string, mailbox?: string): string {
  return [
    '',
    `## Diff — draft ${match.draftId} ↔ sent ${match.messageId}`,
    '',
    ...(mailbox ? [`- mailbox: ${mailbox}`] : []),
    `- thread_id: ${match.threadId || '(none)'}`,
    `- sent_at: ${match.sentAt}`,
    `- subject: ${match.sentSubject}`,
    `- recipients: ${match.sentRecipients.join(', ')}`,
    '',
    '### Draft',
    '',
    match.draftBody.trim() || '_(empty)_',
    '',
    '### Sent',
    '',
    sentBody.trim() || '_(empty)_',
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * Bound calendar-time retention of the rolling evidence doc (pending-diffs.md) by dropping
 * blocks whose `- sent_at:` predates `cutoffIso` (#1419,
 * ADR-029: consumed evidence must not be retained indefinitely). Sensitive full email bodies
 * would otherwise accumulate forever, since appendDoc refreshes `updated_at` on every active run
 * and defeats the idle-TTL sweep.
 *
 * Retention scheme — one mechanism per doc class (T2.2):
 *   - The rolling evidence doc (pending-diffs.md): retained by THIS in-write
 *     trim (a 90-day content window; see EVIDENCE_RETENTION_DAYS in the sent-observe handler). It
 *     also carries an explicit `ttl_days: 90` frontmatter — NOT a restatement of the 7-day default
 *     scratch sweep, but a deliberate override: voice-learn consumes it WEEKLY,
 *     so the aggressive 7-day default sweep could delete still-unconsumed evidence during an idle
 *     stretch. The 90-day idle backstop keeps unconsumed evidence alive (and cleans a truly
 *     abandoned doc). Both layers are load-bearing.
 *   - Per-item docs (draft snapshots, shadow docs): no in-write trim — retained solely by the
 *     default idle scratch sweep (purgeExpiredScratch). That single mechanism is their retention.
 *
 * Boundaries: each block starts at a real `## Diff — ` header — recognized ONLY when it is
 * followed (allowing one blank line) by the metadata envelope formatDiffBlock emits (a `- ` metadata
 * bullet) — and runs up to (not including) the next such header. parsePendingDiffs anchors
 * on the same envelope, so the result round-trips. Anchoring on the envelope (not a bare
 * `## Diff — ` line) is load-bearing for the retention guarantee: a `## Diff — ` line appearing
 * inside a sent email body (surviving htmlToPlainText) would otherwise be treated as a boundary,
 * and when the real parent block is expired its timestamped prefix would drop while the
 * timestamp-less remainder — real, sensitive email content — survived the purge indefinitely.
 * Requiring the envelope keeps such an in-body heading part of its parent block, so it ages out
 * with it. (A `## `-prefixed body line that is not `## Diff — ` at all, e.g. a surviving markdown
 * H2, is likewise never a boundary.) Any leading preamble/header before the first block is
 * preserved. Blocks with a missing or unparseable `sent_at` are KEPT (never drop on parse failure —
 * data loss is worse than over-retention), as is the whole body when `cutoffIso` itself is unparseable.
 */
export function trimEvidenceDoc(body: string, cutoffIso: string): string {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) return body;

  // Lookahead split keeps the header delimiters, so the surviving pieces re-join to the exact
  // original bytes (each block carries its own trailing `---` and blank line). A boundary is a
  // `## Diff — ` header ANCHORED to the metadata envelope formatDiffBlock emits — the header line
  // followed (allowing one blank line) by a `- ` metadata bullet (`- thread_id:`, `- sent_at:`, …).
  // A bare `## Diff — ` line inside a sent email body is followed by prose, not that bulleted
  // envelope, so it is NOT a boundary and stays with its parent block (which ages out together) —
  // see the doc comment for why this closes a retention-bypass leak.
  const parts = body.split(/(?=^## Diff — .*\n\n?- )/m);
  const kept: string[] = [];
  for (const part of parts) {
    // Split only happens at anchored boundaries, so any part that starts with `## Diff — ` is a
    // real block; everything else (doc preamble, or junk not matching the envelope) is passed through.
    if (!/^## Diff — /.test(part)) {
      kept.push(part); // leading preamble / doc header
      continue;
    }
    // The block's metadata `- sent_at:` is the first such line (it precedes any body sections).
    const sentAtRaw = part.match(/^- sent_at:\s*(.+)$/m)?.[1]?.trim();
    const sentAtMs = sentAtRaw ? Date.parse(sentAtRaw) : Number.NaN;
    if (!Number.isFinite(sentAtMs)) {
      kept.push(part); // keep on missing/unparseable timestamp
      continue;
    }
    if (sentAtMs < cutoffMs) continue; // strictly older than the cutoff → drop
    kept.push(part);
  }
  return kept.join('');
}
