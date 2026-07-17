// Pure matching helpers for ceo-inbox-sent-observe (#1422).
// Kept free of I/O so unit tests can cover draft-match and task-match heuristics.

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
  confidence: 'high' | 'medium';
  draftBody: string;
  sentSubject: string;
  sentRecipients: string[];
  sentAt: string;
}

export interface TaskMatch {
  messageId: string;
  taskId: string;
  confidence: 'high' | 'low';
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

    if (threadHit && overlap >= 1) {
      return {
        messageId: sent.id,
        draftId: snap.draftId,
        threadId: sent.threadId,
        confidence: 'high',
        draftBody: snap.body,
        sentSubject: sent.subject,
        sentRecipients: [...sentRecipients],
        sentAt: sentAtIso,
      };
    }

    if (threadHit) {
      best = {
        messageId: sent.id,
        draftId: snap.draftId,
        threadId: sent.threadId,
        confidence: 'high',
        draftBody: snap.body,
        sentSubject: sent.subject,
        sentRecipients: [...sentRecipients],
        sentAt: sentAtIso,
      };
      continue;
    }

    if (overlap >= 1 && subjectSimilar(sent.subject, snap.subject)) {
      const candidate: DraftMatch = {
        messageId: sent.id,
        draftId: snap.draftId,
        threadId: sent.threadId || snap.threadId,
        confidence: 'medium',
        draftBody: snap.body,
        sentSubject: sent.subject,
        sentRecipients: [...sentRecipients],
        sentAt: sentAtIso,
      };
      if (!best || best.confidence === 'medium') best = candidate;
    }
  }

  return best;
}

/**
 * Match a sent message to open CEO tasks.
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

/** Format a (draft, sent) pair for the rolling evidence doc. */
export function formatDiffBlock(match: DraftMatch, sentBody: string): string {
  return [
    '',
    `## Diff — draft ${match.draftId} ↔ sent ${match.messageId}`,
    '',
    `- thread_id: ${match.threadId || '(none)'}`,
    `- confidence: ${match.confidence}`,
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
 * Bound calendar-time retention of a rolling evidence doc (pending-diffs.md /
 * pending-completions.md) by dropping blocks whose `- sent_at:` predates `cutoffIso` (#1419,
 * ADR-029: consumed evidence must not be retained indefinitely). Sensitive full email bodies
 * would otherwise accumulate forever, since appendDoc refreshes `updated_at` on every active run
 * and defeats the idle-TTL sweep.
 *
 * Boundaries: each block starts at a real `## Diff — ` / `## Candidate — ` header and runs up to
 * (not including) the next such header — the same headers formatDiffBlock/formatCompletionCandidateBlock
 * produce and parsePendingDiffs/parseCompletionCandidates consume, so the result round-trips. We split
 * on the namespaced headers, NOT any `## ` line, so a `## `-prefixed line inside a sent email body
 * (a markdown H2 surviving htmlToPlainText) stays part of its block instead of mis-splitting it and
 * leaving a timestamp-less tail behind. Any leading preamble/header before the first block is
 * preserved. Blocks with a missing or unparseable `sent_at` are KEPT (never drop on parse failure —
 * data loss is worse than over-retention), as is the whole body when `cutoffIso` itself is unparseable.
 */
export function trimEvidenceDoc(body: string, cutoffIso: string): string {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) return body;

  // Lookahead split keeps the header delimiters, so the surviving pieces re-join to the exact
  // original bytes (each block carries its own trailing `---` and blank line). Split only on the
  // real block headers (`## Diff — ` / `## Candidate — `), never a bare `## ` — see the doc comment.
  const parts = body.split(/(?=^## (?:Diff|Candidate) — )/m);
  const kept: string[] = [];
  for (const part of parts) {
    if (!/^## (?:Diff|Candidate) — /.test(part)) {
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

/** Format a completion candidate block for pending-completions.md. */
export function formatCompletionCandidateBlock(match: TaskMatch): string {
  return [
    '',
    `## Candidate — task ${match.taskId}`,
    '',
    `- message_id: ${match.messageId}`,
    `- confidence: ${match.confidence}`,
    `- reason: ${match.reason}`,
    `- sent_at: ${match.sentAt}`,
    `- subject: ${match.sentSubject}`,
    `- recipients: ${match.sentRecipients.join(', ')}`,
    `- task_title: ${match.taskTitle}`,
    `- status: pending`,
    '',
    '---',
    '',
  ].join('\n');
}
