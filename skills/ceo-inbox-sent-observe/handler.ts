// ceo-inbox-sent-observe — daily Sent-folder poll for voice learning + task completion (#1422).
//
// Watermarked like the inbound email poll. Self-throttles via last_run_found_nothing_at
// (t2125 pattern). Capture/match failures on individual messages log and continue.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import {
  CeoNylasClient,
  htmlToPlainText,
  type NylasMessageSummary,
} from '../_shared/ceo-nylas-client.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import {
  VOICE_LEARNING_DOC_TYPE,
  VOICE_LEARNING_SCRATCH_PREFIX,
} from '../_shared/voice-learning-capture.js';
import {
  formatCompletionCandidateBlock,
  formatDiffBlock,
  matchDraftToSent,
  matchTasksToSent,
  trimEvidenceDoc,
  type DraftSnapshotLike,
} from '../_shared/sent-observe-match.js';
import { createCeoSentObserved } from '../../src/bus/events.js';
import {
  parseShadowDoc,
  buildShadowJudgePrompt,
  parseShadowJudgeResult,
  SHADOW_SCRATCH_PREFIX,
  type ShadowJudgePair,
  type ShadowJudgement,
  type ShadowSnapshot,
} from '../_shared/shadow-draft.js';

export const CONFIG_NAMESPACE = 'ceo_inbox';
export const WATERMARK_KEY = 'sent_observe.last_seen_at';
export const IDLE_BACKOFF_KEY = 'sent_observe.last_run_found_nothing_at';
export const PENDING_DIFFS_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/pending-diffs.md`;
export const PENDING_COMPLETIONS_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/pending-completions.md`;
export const PENDING_DIFFS_TYPE = 'voice-pending-diffs';
export const PENDING_COMPLETIONS_TYPE = 'voice-pending-completions';

/** Calendar-time retention bound for the rolling evidence docs (pending-diffs.md /
 *  pending-completions.md), per ADR-029: their sensitive full email bodies must not be retained
 *  indefinitely. 90 days comfortably exceeds the weekly voice-learn window (MAX_PAIRS=40) and the
 *  daily task-completion cadence, so no still-useful evidence is trimmed early. Doubles as the
 *  `ttl_days` frontmatter backstop so a doc that STOPS being appended still ages out via the
 *  idle-TTL sweep (purgeExpiredScratch). */
export const EVIDENCE_RETENTION_DAYS = 90;

/** Idle backoff when a run finds nothing — 2 hours (t2125 pattern). */
const IDLE_BACKOFF_MS = 2 * 60 * 60 * 1000;

/** Safety ceiling on messages scanned per run — a daily Sent volume never reaches
 *  this, but it bounds a runaway mailbox. Truncation is handled by holding the
 *  watermark (see watermark-advance below), not by silently dropping the tail. */
const SENT_MAX_SCAN = 500;

const EPOCH = '0';

function parseSnapshot(doc: {
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
  body: string;
}): DraftSnapshotLike | null {
  if (doc.type !== VOICE_LEARNING_DOC_TYPE) return null;
  const fm = doc.frontmatter;
  const draftId = typeof fm.draft_id === 'string' ? fm.draft_id : '';
  if (!draftId) return null;

  const recipientsRaw = fm.recipients;
  let to: Array<{ email: string }> = [];
  let cc: Array<{ email: string }> = [];
  if (recipientsRaw && typeof recipientsRaw === 'object') {
    const rec = recipientsRaw as Record<string, unknown>;
    if (Array.isArray(rec.to)) {
      to = rec.to
        .filter((p): p is { email: string } => !!p && typeof p === 'object' && typeof (p as { email?: unknown }).email === 'string')
        .map((p) => ({ email: p.email }));
    }
    if (Array.isArray(rec.cc)) {
      cc = rec.cc
        .filter((p): p is { email: string } => !!p && typeof p === 'object' && typeof (p as { email?: unknown }).email === 'string')
        .map((p) => ({ email: p.email }));
    }
  }

  return {
    draftId,
    threadId: typeof fm.thread_id === 'string' ? fm.thread_id : '',
    subject: typeof fm.subject === 'string' ? fm.subject : '',
    recipients: { to, cc },
    body: doc.body,
    createdAt: typeof fm.created_at === 'string' ? fm.created_at : new Date(0).toISOString(),
  };
}

function extractMatchedDraftIds(pendingDiffsBody: string): Set<string> {
  const ids = new Set<string>();
  for (const m of pendingDiffsBody.matchAll(/draft\s+([^\s↔]+)\s*↔/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

function extractAskedTaskIds(pendingCompletionsBody: string): Set<string> {
  // Every candidate (including ones later stamped with a `completion_asked` marker)
  // keeps its `## Candidate — task <id>` header, so this single pass covers them all.
  const ids = new Set<string>();
  for (const m of pendingCompletionsBody.matchAll(/## Candidate — task\s+(\S+)/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/** ISO timestamp → Unix seconds, or null when missing/unparseable. */
function isoToUnixSeconds(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Strip a leading Re:/Fwd: and normalize whitespace/case for loose subject comparison. */
function normalizeSubjectKey(subject: string): string {
  return subject
    .replace(/^(re|fwd|fw):\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function subjectsSimilar(a: string, b: string): boolean {
  const na = normalizeSubjectKey(a);
  const nb = normalizeSubjectKey(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** True when any of the shadow's recorded recipients appears in the message's to/cc. */
function shadowRecipientsOverlap(
  shadowRecipients: string[],
  msg: { to: Array<{ email: string }>; cc: Array<{ email: string }> },
): boolean {
  const want = new Set(shadowRecipients.map((r) => r.trim().toLowerCase()));
  if (want.size === 0) return false;
  for (const p of [...msg.to, ...msg.cc]) {
    if (want.has(p.email.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * Finding 6 (#1426): pick the send that best corresponds to a shadow draft.
 *
 * Messages are iterated newest-first, so claiming the first same-thread message can score
 * the shadow against a NEWER, unrelated send that happened after the one the shadow was
 * drafted for. Instead choose the *nearest eligible* send: same thread, sent at/after the
 * shadow was captured (2-min clock skew allowed, mirroring matchDraftToSent), preferring
 * subject/recipient-consistent candidates and then the closest in time. A direct
 * `sourceMessageId === msg.id` hit remains an exact-match fast path. Returns null when no
 * eligible send exists (the shadow stays unclaimed and is retried next run).
 */
function selectShadowSend(
  shadow: ShadowSnapshot,
  messages: NylasMessageSummary[],
): NylasMessageSummary | null {
  // Exact-match fast path — a send whose id IS the shadow's recorded source message.
  const exact = messages.find((m) => m.id === shadow.sourceMessageId);
  if (exact) return exact;

  const createdSec = isoToUnixSeconds(shadow.createdAt);
  const SKEW_SEC = 120;

  const eligible = messages.filter((m) => {
    if (!(shadow.threadId && m.threadId && shadow.threadId === m.threadId)) return false;
    // The send must not precede the shadow's capture. When createdAt is unparseable we
    // can't gate on time, so we accept and rank by recency below.
    if (createdSec !== null && m.date + SKEW_SEC < createdSec) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  // Refine by subject/recipient when both sides carry those fields. Only narrow when at
  // least one candidate matches, so a thread whose subjects/recipients drifted doesn't
  // exclude every candidate and strand the shadow.
  const refined = eligible.filter((m) => {
    const subjectOk = !shadow.subject || !m.subject || subjectsSimilar(shadow.subject, m.subject);
    const recipientOk =
      shadow.recipients.length === 0 || shadowRecipientsOverlap(shadow.recipients, m);
    return subjectOk && recipientOk;
  });
  const pool = refined.length > 0 ? refined : eligible;

  // Nearest in time to the shadow's capture (or newest when capture time is unknown).
  let best: NylasMessageSummary | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const m of pool) {
    const delta = createdSec !== null ? Math.abs(m.date - createdSec) : -m.date;
    if (delta < bestDelta) {
      best = m;
      bestDelta = delta;
    }
  }
  return best;
}

async function ensureDoc(
  ctx: SkillContext,
  path: string,
  type: string,
  title: string,
): Promise<{ body: string; version: number }> {
  const repo = ctx.workingDocs!;
  const existing = await repo.read(path);
  if (existing) return { body: existing.body, version: existing.version };
  const created = await repo.create({
    path,
    type,
    // ttl_days backstop (ADR-029): purgeExpiredScratch honors this on scratch paths, so a doc
    // that stops being appended still ages out. ensureDoc only ever creates the two rolling
    // evidence docs, both of which want this bound. The trim on append covers the active case.
    frontmatter: { title, ttl_days: EVIDENCE_RETENTION_DAYS },
    body: `# ${title}\n\n`,
    agentId: ctx.agentId,
    conversationId: ctx.conversationId,
  });
  return { body: created.body, version: created.version };
}

/** Append to a rolling evidence doc AND bound its calendar-time retention in one write: read the
 *  current body, append `newContent`, drop blocks older than `cutoffIso` (trimEvidenceDoc), and
 *  write the whole body back with the same 3-attempt conflict-retry loop appendDoc used. Returns
 *  true when the content was persisted (or there was nothing to write), false when every attempt
 *  lost the version race — the caller uses this to decide whether the watermark may advance, since
 *  persisting evidence must succeed before we forget the messages that produced it.
 *
 *  Trimming rides along on the append write, so a lost race just retries the whole thing; there is
 *  no separate trim write that could fail independently. */
async function appendAndTrimDoc(
  ctx: SkillContext,
  path: string,
  type: string,
  title: string,
  newContent: string,
  cutoffIso: string,
): Promise<boolean> {
  if (!newContent.trim()) return true;
  const repo = ctx.workingDocs!;
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await ensureDoc(ctx, path, type, title);
    // Mirror repo.append's body joining (strip one trailing newline, then a blank line) so the
    // combined body stays well-formed before trimming.
    const combined = doc.body.length > 0
      ? `${doc.body.replace(/\n$/, '')}\n\n${newContent}`
      : newContent;
    const newBody = trimEvidenceDoc(combined, cutoffIso);
    const result = await repo.update(path, {
      body: newBody,
      expectedVersion: doc.version,
    });
    if (result.ok) return true;
  }
  ctx.log.warn({ path }, 'ceo-inbox-sent-observe: failed to append+trim after conflicts');
  return false;
}

export class CeoInboxSentObserveHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Skill contract: never throw. Any Nylas / config / document / task / bus rejection
    // that escapes the inner flow is normalized to a failure result here.
    try {
      return await this.runObserve(ctx);
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-sent-observe: unexpected failure');
      return {
        success: false,
        error: `sent-observe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async runObserve(ctx: SkillContext): Promise<SkillResult> {
    let apiKey: string;
    let grantId: string;
    try {
      apiKey = ctx.secret('nylas_api_key');
      grantId = ctx.secret('ceo_nylas_grant_id');
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-sent-observe: required secret not available');
      return { success: false, error: 'CEO inbox is not configured (missing credentials)' };
    }

    if (!ctx.entityMemory || !ctx.workingDocs || !ctx.taskRepo || !ctx.bus) {
      return {
        success: false,
        error: 'ceo-inbox-sent-observe requires entityMemory, workingDocs, taskRepo, and bus',
      };
    }
    // actionLogRepo is optional at runtime for backward-compatible tests; shadow
    // reconciliation is skipped when absent.

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const force = input.force === true;
    // Undocumented test seam — inject fixed "now" for deterministic backoff tests.
    const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();

    const store = new ConfigStore(ctx.entityMemory, ctx.log);

    // Self-throttle: if the last idle run was recent, skip (unless force).
    if (!force) {
      const idleAt = await store.get(CONFIG_NAMESPACE, IDLE_BACKOFF_KEY);
      if (idleAt && idleAt !== EPOCH) {
        const idleMs = Number(idleAt);
        if (Number.isFinite(idleMs) && nowMs - idleMs < IDLE_BACKOFF_MS) {
          ctx.log.info(
            { idleAt, backoffMs: IDLE_BACKOFF_MS },
            'ceo-inbox-sent-observe: skipping — idle backoff active',
          );
          if (ctx.bus) {
            await ctx.bus.publish(
              'execution',
              createCeoSentObserved({
                messagesScanned: 0,
                draftMatches: 0,
                taskCandidates: 0,
                watermarkAdvancedTo: null,
                skippedBackoff: true,
                parentEventId: ctx.taskEventId,
              }),
            );
          }
          return {
            success: true,
            data: {
              messages_scanned: 0,
              draft_matches: 0,
              task_candidates: 0,
              shadow_reconciled: 0,
              watermark_advanced_to: null,
              skipped_backoff: true,
            },
          };
        }
      }
    }

    const watermarkRaw = await store.get(CONFIG_NAMESPACE, WATERMARK_KEY);
    const watermark = watermarkRaw && Number.isFinite(Number(watermarkRaw))
      ? Number(watermarkRaw)
      : 0;

    const client = new CeoNylasClient(apiKey, grantId, ctx.log);
    // Paginate the whole watermark window — a single fixed-limit page silently drops
    // everything past the newest 20 on a busy Sent folder (#1429 review). `truncated`
    // means the maxScan ceiling was hit and older sends remain unseen this run.
    const { messages, truncated } = await client.listAllMessages({
      folder: 'SENT',
      ...(watermark > 0 ? { receivedAfter: watermark } : {}),
      maxScan: SENT_MAX_SCAN,
    });

    // Load draft snapshots + pending evidence.
    const scratchDocs = await ctx.workingDocs.listByPrefix(`${VOICE_LEARNING_SCRATCH_PREFIX}/`);
    const snapshots = scratchDocs
      .map(parseSnapshot)
      .filter((s): s is DraftSnapshotLike => s !== null);

    const pendingDiffs = await ensureDoc(ctx, PENDING_DIFFS_PATH, PENDING_DIFFS_TYPE, 'Pending voice diffs');
    const pendingCompletions = await ensureDoc(
      ctx,
      PENDING_COMPLETIONS_PATH,
      PENDING_COMPLETIONS_TYPE,
      'Pending task-completion candidates',
    );
    const alreadyMatchedDraftIds = extractMatchedDraftIds(pendingDiffs.body);
    const alreadyAskedTaskIds = extractAskedTaskIds(pendingCompletions.body);

    const OPEN_TASK_LIMIT = 100;
    const openTasks = await ctx.taskRepo.listTasks({
      owner: 'ceo',
      statuses: ['open', 'in_progress'],
      limit: OPEN_TASK_LIMIT,
    });
    // taskRepo.listTasks has no keyset/pagination, so completion matching considers at
    // most OPEN_TASK_LIMIT tasks. Log when the cap is hit so a silently-partial match set
    // is visible rather than mistaken for full coverage (keyset paging tracked separately).
    if (openTasks.length >= OPEN_TASK_LIMIT) {
      ctx.log.warn(
        { openTaskLimit: OPEN_TASK_LIMIT },
        'ceo-inbox-sent-observe: open CEO task list hit the fetch cap — some tasks were not considered for completion',
      );
    }

    let draftMatches = 0;
    let taskCandidates = 0;
    let shadowReconciled = 0;
    let maxDate = watermark;
    // Oldest message actually processed this run. Diagnostics only: it's surfaced as
    // `oldestScannedAt` in the truncation warning so an operator can see where the
    // skipped tail begins. The watermark still advances to maxDate + 1 on truncation
    // (see the watermark-advance block below) — minDate does NOT hold it back.
    let minDate = Number.POSITIVE_INFINITY;
    const diffChunks: string[] = [];
    const completionChunks: string[] = [];

    const shadowDocs = await ctx.workingDocs.listByPrefix(`${SHADOW_SCRATCH_PREFIX}/`);
    const shadows = shadowDocs
      .map((d) => parseShadowDoc(d))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    // Guard against scoring the same shadow twice when several sends share a thread
    // in one run (the durable guard is the shadow doc's reconciled_at marker).
    const claimedShadows = new Set<string>();
    // (shadow, sent) pairs collected during the message loop below, judged in a
    // single batched LLM call after the loop instead of one call per pair.
    const judgePairs: ShadowJudgePair[] = [];

    // Full sent bodies fetched during the message loop (for draft diffs), keyed by
    // message id so shadow reconcile can reuse them instead of re-fetching.
    const fetchedBodies = new Map<string, string>();

    for (const msg of messages) {
      if (msg.date > maxDate) maxDate = msg.date;
      if (msg.date < minDate) minDate = msg.date;

      let sentBody = msg.snippet ?? '';

      const draftMatch = matchDraftToSent(msg, snapshots, alreadyMatchedDraftIds);
      if (draftMatch) {
        alreadyMatchedDraftIds.add(draftMatch.draftId);
        try {
          const full = await client.getMessage(msg.id);
          sentBody = htmlToPlainText(full.body) || full.snippet || sentBody;
          fetchedBodies.set(msg.id, sentBody);
        } catch (err) {
          ctx.log.warn(
            { err, messageId: msg.id },
            'ceo-inbox-sent-observe: getMessage failed — using snippet for sent body',
          );
        }
        diffChunks.push(formatDiffBlock(draftMatch, sentBody));
        draftMatches += 1;
      }

      const taskMatches = matchTasksToSent(msg, openTasks, alreadyAskedTaskIds);
      for (const tm of taskMatches) {
        alreadyAskedTaskIds.add(tm.taskId);
        completionChunks.push(formatCompletionCandidateBlock(tm));
        taskCandidates += 1;
      }
    }

    // Shadow-draft competence reconcile (#1426). Runs AFTER the message loop so each shadow
    // can be matched to the *nearest eligible* send across the whole window rather than the
    // first newest same-thread message (Finding 6). shadowReconcileOk gates the watermark:
    // any un-scored / un-reconciled shadow flips it false so the carrying Sent message is
    // re-observed next run (received_after is an exclusive lower bound). Declared here (not at
    // the batch loop) so a body-fetch failure below can hold the watermark too.
    let shadowReconcileOk = true;
    if (ctx.actionLogRepo) {
      for (const shadow of shadows) {
        if (claimedShadows.has(shadow.sourceMessageId)) continue;
        const send = selectShadowSend(shadow, messages);
        if (!send) continue;
        // Claim so two shadows or a later run can't re-score the same one this run.
        claimedShadows.add(shadow.sourceMessageId);

        // Finding 7: never judge against a truncated snippet — the LLM would write a false
        // competence score. If the full sent body can't be fetched, don't push the pair,
        // release the claim, and hold the watermark so the send is re-observed next run.
        const cachedBody = fetchedBodies.get(send.id);
        let sentBody: string;
        if (cachedBody !== undefined) {
          sentBody = cachedBody;
        } else {
          try {
            const full = await client.getMessage(send.id);
            sentBody = htmlToPlainText(full.body) || full.snippet || '';
          } catch (err) {
            ctx.log.warn(
              { err, messageId: send.id, sourceMessageId: shadow.sourceMessageId },
              'ceo-inbox-sent-observe: getMessage failed for shadow reconcile — not scoring, holding watermark',
            );
            claimedShadows.delete(shadow.sourceMessageId);
            shadowReconcileOk = false;
            continue;
          }
        }
        // Don't score inline — collect the pair and judge everything in one batched LLM
        // call after this loop (see below).
        judgePairs.push({
          sourceMessageId: shadow.sourceMessageId,
          subject: send.subject || shadow.subject,
          shadowBody: shadow.body,
          sentBody,
        });
      }
    }

    // Shadow-draft competence reconcile, batched (#1419 / ADR-029): one LLM call per
    // up-to-20 pairs rather than one per pair. A failed batch call leaves those shadow
    // docs' reconciled_at unset — but `received_after` is an exclusive lower bound, so the
    // Sent message that carried the shadow is only re-fetched next run if we HOLD the
    // watermark. shadowReconcileOk tracks that: any failed batch flips it false and the
    // watermark-advance guard below blocks the advance. Retry is idempotent because
    // already-reconciled shadows are skipped (parseShadowDoc returns null once reconciled_at
    // is set) and diff/completion matching is idempotent via the already-matched/asked sets.
    if (judgePairs.length > 0 && ctx.infraLlm && ctx.actionLogRepo) {
      const BATCH = 20;
      for (let i = 0; i < judgePairs.length; i += BATCH) {
        const batch = judgePairs.slice(i, i + BATCH);
        const res = await ctx.infraLlm.extract(buildShadowJudgePrompt(batch), { maxTokens: 1500 });
        if (!res.ok) {
          shadowReconcileOk = false;
          ctx.log.warn(
            { error: res.error, count: batch.length },
            'sent-observe: shadow judge LLM failed — holding watermark so these sends are re-observed next run',
          );
          continue; // reconciled_at stays unset → retried next run (watermark held below)
        }

        // Finding 8: the batch counts as reconciled ONLY if every pair got exactly one
        // judgement, every insert succeeded, and every reconciled_at mark persisted. Index
        // judgements by source id and flag duplicates — a repeated id is ambiguous (which
        // verdict wins?) so we refuse to reconcile those pairs and hold the watermark.
        const judgements = parseShadowJudgeResult(res.text);
        const byId = new Map<string, ShadowJudgement>();
        const duplicateIds = new Set<string>();
        for (const j of judgements) {
          if (byId.has(j.sourceMessageId)) duplicateIds.add(j.sourceMessageId);
          else byId.set(j.sourceMessageId, j);
        }
        if (duplicateIds.size > 0) {
          shadowReconcileOk = false;
          ctx.log.warn(
            { duplicateIds: [...duplicateIds] },
            'sent-observe: shadow judge returned duplicate judgements — holding watermark',
          );
        }

        for (const pair of batch) {
          const j = byId.get(pair.sourceMessageId);
          // Missing or ambiguous (duplicated) judgement → this shadow stays unreconciled.
          if (!j || duplicateIds.has(pair.sourceMessageId)) {
            shadowReconcileOk = false;
            if (!j) {
              ctx.log.warn(
                { sourceMessageId: pair.sourceMessageId },
                'sent-observe: shadow judge omitted a pair — holding watermark',
              );
            }
            continue;
          }
          try {
            await ctx.actionLogRepo.insert({
              taskId: ctx.taskEventId ?? `shadow:${j.sourceMessageId}`,
              conversationId: ctx.conversationId,
              skillName: 'shadow-draft-eval',
              actionRisk: 'none',
              outcome: 'shadow_evaluated',
              taskSummary: `Shadow vs sent (${j.sourceMessageId}): ${j.reason}`,
              payload: { shadow: true, source_message_id: j.sourceMessageId, competence_reason: j.reason },
              competenceFlag: j.sameDecision ? 1 : 0,
              commitmentFlag: null,
              compatibility: null,
              scoredBy: 'shadow-reconciler',
            });
          } catch (err) {
            // A failed insert must not silently strand the pair — hold the watermark so it
            // retries next run (reconciled_at is unset, so the shadow is re-judged).
            shadowReconcileOk = false;
            ctx.log.error(
              { err, sourceMessageId: j.sourceMessageId },
              'sent-observe: shadow competence insert failed — holding watermark',
            );
            continue;
          }

          // Insert succeeded — durably mark the shadow doc reconciled so retry skips it.
          const path = `${SHADOW_SCRATCH_PREFIX}/${j.sourceMessageId}.md`;
          const doc = await ctx.workingDocs.read(path);
          if (!doc) {
            // Doc vanished before we could mark it — treat as not durably reconciled so the
            // batch holds the watermark (a stray re-insert next run is harmless).
            shadowReconcileOk = false;
            ctx.log.warn(
              { sourceMessageId: j.sourceMessageId },
              'sent-observe: shadow doc missing at mark time — holding watermark',
            );
            continue;
          }
          const upd = await ctx.workingDocs.update(path, {
            frontmatter: { ...doc.frontmatter, reconciled_at: new Date().toISOString(), competence_flag: j.sameDecision ? 1 : 0 },
            expectedVersion: doc.version,
          });
          if (!upd.ok) {
            // Version conflict — the reconciled_at mark didn't land, so hold the watermark.
            shadowReconcileOk = false;
            ctx.log.warn(
              { sourceMessageId: j.sourceMessageId },
              'sent-observe: shadow doc mark update conflict — holding watermark',
            );
            continue;
          }
          // Only a successful insert AND durable mark counts as reconciled.
          shadowReconciled += 1;
        }
      }
    }

    // Retention cutoff for the rolling evidence docs (ADR-029): blocks older than this are dropped
    // on write. Derived from the same injected `now` the backoff gate uses, so trimming is
    // deterministic under test.
    const cutoffIso = new Date(nowMs - EVIDENCE_RETENTION_DAYS * 86_400_000).toISOString();
    const diffsPersisted = await appendAndTrimDoc(
      ctx,
      PENDING_DIFFS_PATH,
      PENDING_DIFFS_TYPE,
      'Pending voice diffs',
      diffChunks.join(''),
      cutoffIso,
    );
    const completionsPersisted = await appendAndTrimDoc(
      ctx,
      PENDING_COMPLETIONS_PATH,
      PENDING_COMPLETIONS_TYPE,
      'Pending task-completion candidates',
      completionChunks.join(''),
      cutoffIso,
    );
    // If evidence didn't reach OKF, hold the watermark so those messages are re-observed
    // next run (matching is idempotent via the already-matched/asked sets seeded from the
    // docs, so the successful writes won't duplicate).
    const evidencePersisted = diffsPersisted && completionsPersisted;
    // The watermark may only advance when BOTH the rolling evidence persisted AND every shadow
    // batch reconciled. A failed shadow batch (shadowReconcileOk === false) holds it too, so the
    // orphaned shadow's Sent message is re-fetched next run instead of being stranded past the
    // exclusive `received_after` floor (its doc is otherwise TTL-swept after 7 idle days).
    const advanceOk = evidencePersisted && shadowReconcileOk;

    // Advance the watermark past the newest message seen (exclusive next poll).
    //
    // Nylas returns newest-first and `received_after` is an exclusive lower bound, so
    // a single-floor poll can only ever walk *forward*. On truncation the un-fetched
    // messages are the OLDEST in the window (date < minDate); there is no lower-bound
    // value that both advances and re-includes them, so we do not attempt a partial
    // hold (an earlier version did and simply stranded the tail while re-scanning the
    // newest 500 forever). Instead we advance to the newest seen and log — loudly and
    // accurately — that older messages were skipped. This is realistically only a
    // first-run/backfill event against a large existing mailbox; day-to-day Sent volume
    // never approaches SENT_MAX_SCAN, and back-mining old history is not a goal of a
    // forward-looking observer. Draining a true >ceiling backlog would need oldest-first
    // paging (received_before), deliberately out of scope here.
    let watermarkAdvancedTo: number | null = null;
    if (messages.length > 0 && maxDate >= watermark && advanceOk) {
      watermarkAdvancedTo = maxDate + 1;
      await store.set(CONFIG_NAMESPACE, WATERMARK_KEY, String(watermarkAdvancedTo));
    } else if (messages.length > 0 && !advanceOk) {
      ctx.log.warn(
        {
          path: PENDING_DIFFS_PATH,
          evidencePersisted,
          shadowReconcileOk,
        },
        !evidencePersisted
          ? 'ceo-inbox-sent-observe: evidence persistence failed — holding watermark for retry'
          : 'ceo-inbox-sent-observe: shadow reconcile failed — holding watermark for retry',
      );
    }
    if (truncated) {
      ctx.log.warn(
        {
          scanned: messages.length,
          maxScan: SENT_MAX_SCAN,
          oldestScannedAt: Number.isFinite(minDate) ? minDate : null,
          advancedTo: watermarkAdvancedTo,
        },
        `ceo-inbox-sent-observe: Sent window exceeded the ${SENT_MAX_SCAN}-message scan ceiling — ` +
          'messages older than the newest batch were NOT observed and will not be revisited ' +
          '(expected only on first run against a large mailbox).',
      );
    }

    if (messages.length === 0) {
      await store.set(CONFIG_NAMESPACE, IDLE_BACKOFF_KEY, String(nowMs));
    } else {
      await store.set(CONFIG_NAMESPACE, IDLE_BACKOFF_KEY, EPOCH);
    }

    await ctx.bus.publish(
      'execution',
      createCeoSentObserved({
        messagesScanned: messages.length,
        draftMatches,
        taskCandidates,
        watermarkAdvancedTo,
        skippedBackoff: false,
        parentEventId: ctx.taskEventId,
      }),
    );

    ctx.log.info(
      {
        messagesScanned: messages.length,
        draftMatches,
        taskCandidates,
        shadowReconciled,
        watermarkAdvancedTo,
      },
      'ceo-inbox-sent-observe: run complete',
    );

    return {
      success: true,
      data: {
        messages_scanned: messages.length,
        draft_matches: draftMatches,
        task_candidates: taskCandidates,
        shadow_reconciled: shadowReconciled,
        watermark_advanced_to: watermarkAdvancedTo,
        skipped_backoff: false,
      },
    };
  }
}
