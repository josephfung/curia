// ceo-inbox-sent-observe — daily Sent-folder poll for voice learning + task completion (#1422).
//
// Watermarked like the inbound email poll. Self-throttles via last_run_found_nothing_at
// (t2125 pattern). Capture/match failures on individual messages log and continue.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import {
  CeoNylasClient,
  htmlToPlainText,
  type NylasMessageSummary,
} from '../../../_shared/ceo-nylas-client.js';
import { ConfigStore } from '../../../../src/memory/config-store.js';
import {
  VOICE_LEARNING_DOC_TYPE,
  VOICE_LEARNING_SCRATCH_PREFIX,
} from '../../../_shared/voice-learning-capture.js';
import {
  formatDiffBlock,
  matchDraftToSent,
  matchTasksToSent,
  trimEvidenceDoc,
  type DraftSnapshotLike,
} from '../../../_shared/sent-observe-match.js';
import {
  parseShadowDoc,
  buildShadowJudgePrompt,
  parseShadowJudgeResult,
  SHADOW_SCRATCH_PREFIX,
  type ShadowJudgePair,
  type ShadowSnapshot,
} from '../../../_shared/shadow-draft.js';
import {
  readCompletionCandidates,
  writeCompletionCandidates,
  readIdSet,
  writeIdSet,
  ASKED_TASK_IDS_KEY,
  MATCHED_DRAFT_IDS_KEY,
  COMPLETION_CANDIDATES_KEY,
  type CompletionCandidateMap,
  type CompletionCandidate,
} from '../../../_shared/learning-state.js';

export const CONFIG_NAMESPACE = 'ceo_inbox';
export const WATERMARK_KEY = 'sent_observe.last_seen_at';
export const IDLE_BACKOFF_KEY = 'sent_observe.last_run_found_nothing_at';
/** Descending `received_before` ceiling for an in-progress oldest-first backlog drain (#1431). A
 *  value > EPOCH means a drain is underway; it walks down toward WATERMARK across successive runs.
 *  See the watermark/backfill state machine defined by the state-key constants below. */
export const BACKFILL_BEFORE_KEY = 'sent_observe.backfill_before';
/** Newest message date captured when a >SENT_MAX_SCAN backlog was first detected (#1431). The
 *  watermark jumps to backfill_target + 1 only once the drain reaches its oldest sub-window, so the
 *  watermark never sits above an un-drained message. */
export const BACKFILL_TARGET_KEY = 'sent_observe.backfill_target';
export const PENDING_DIFFS_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/pending-diffs.md`;
export const PENDING_DIFFS_TYPE = 'voice-pending-diffs';

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

/** ISO timestamp → Unix seconds, or null when missing/unparseable. */
function isoToUnixSeconds(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Strip a leading Re:/Fwd: and normalize whitespace/case for loose subject comparison. */

/**
 * Pick the send that corresponds to a shadow draft (#1426). The CEO's reply to a punted message
 * near-always shares its thread, and an unmatched shadow is simply retried on later runs (then
 * TTL-swept after 7 idle days), so a simple two-rule match is enough:
 *   (a) exact `id === sourceMessageId` fast path;
 *   (b) otherwise the nearest-in-time same-thread send at/after capture (2-min clock skew,
 *       mirroring matchDraftToSent).
 * Newest-first iteration would otherwise score the shadow against a newer, unrelated same-thread
 * send. Returns null when no eligible send exists (the shadow retries next run).
 */
function selectShadowSend(
  shadow: ShadowSnapshot,
  messages: NylasMessageSummary[],
): NylasMessageSummary | null {
  const exact = messages.find((m) => m.id === shadow.sourceMessageId);
  if (exact) return exact;

  const createdSec = isoToUnixSeconds(shadow.createdAt);
  const SKEW_SEC = 120;

  // Nearest same-thread send at/after capture (newest when capture time is unparseable).
  let best: NylasMessageSummary | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const m of messages) {
    if (!(shadow.threadId && m.threadId && shadow.threadId === m.threadId)) continue;
    if (createdSec !== null && m.date + SKEW_SEC < createdSec) continue;
    const delta = createdSec !== null ? Math.abs(m.date - createdSec) : -m.date;
    if (delta < bestDelta) {
      best = m;
      bestDelta = delta;
    }
  }
  return best;
}

async function ensureDoc(
  ctx: ToolContext,
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
  ctx: ToolContext,
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

export class CeoInboxSentObserveHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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

  private async runObserve(ctx: ToolContext): Promise<ToolResult> {
    let apiKey: string;
    let grantId: string;
    try {
      apiKey = ctx.secret('nylas_api_key');
      grantId = ctx.secret('ceo_nylas_grant_id');
    } catch (err) {
      ctx.log.error({ err }, 'ceo-inbox-sent-observe: required secret not available');
      return { success: false, error: 'CEO inbox is not configured (missing credentials)' };
    }

    if (!ctx.entityMemory || !ctx.workingDocs || !ctx.taskRepo) {
      return {
        success: false,
        error: 'ceo-inbox-sent-observe requires entityMemory, workingDocs, taskRepo',
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
          return {
            success: true,
            data: {
              messages_scanned: 0,
              draft_matches: 0,
              task_candidates: 0,
              shadow_reconciled: 0,
              watermark_advanced_to: null,
              // The idle-backoff skip never runs mid-drain (a drain finds messages, so it never
              // registers the idle backoff that would gate this early return).
              backfill_active: false,
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

    // Oldest-first backlog drain state (#1431). When a forward poll finds more than SENT_MAX_SCAN
    // messages above a real floor, we can't reach the older tail via a single newest-first floor,
    // so we record a descending `received_before` ceiling (backfillBefore) and the newest date seen
    // (backfillTarget). While a drain is active the watermark stays pinned to its floor and each run
    // scans [watermark, backfillBefore], walking the ceiling down until the window fits — then the
    // watermark jumps to backfillTarget + 1. EPOCH ('0') means the key is unset (a real ceiling /
    // target is always a Unix-second value > 0).
    const backfillBeforeRaw = await store.get(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY);
    const backfillBefore = backfillBeforeRaw && Number.isFinite(Number(backfillBeforeRaw))
      ? Number(backfillBeforeRaw)
      : 0;
    const backfillTargetRaw = await store.get(CONFIG_NAMESPACE, BACKFILL_TARGET_KEY);
    const backfillTarget = backfillTargetRaw && Number.isFinite(Number(backfillTargetRaw))
      ? Number(backfillTargetRaw)
      : 0;
    const backfillActive = backfillBefore > 0;

    const client = new CeoNylasClient(apiKey, grantId, ctx.log);
    // Paginate the whole watermark window — a single fixed-limit page silently drops
    // everything past the newest 20 on a busy Sent folder (#1429 review). `truncated`
    // means the maxScan ceiling was hit and older sends remain unseen this run. During a
    // drain (#1431) receivedBefore caps the window from the top so we work oldest-ward.
    const { messages, truncated } = await client.listAllMessages({
      folder: 'SENT',
      ...(watermark > 0 ? { receivedAfter: watermark } : {}),
      ...(backfillActive ? { receivedBefore: backfillBefore } : {}),
      maxScan: SENT_MAX_SCAN,
    });

    // Load draft snapshots + pending evidence.
    const scratchDocs = await ctx.workingDocs.listByPrefix(`${VOICE_LEARNING_SCRATCH_PREFIX}/`);
    const snapshots = scratchDocs
      .map(parseSnapshot)
      .filter((s): s is DraftSnapshotLike => s !== null);

    // Ensure the doc exists ahead of the append below (appendAndTrimDoc re-reads it itself); its
    // body is no longer scanned for guard ids (#1438 — the matched-draft guard now lives in
    // config, seeded just below), so the result isn't bound to a variable.
    await ensureDoc(ctx, PENDING_DIFFS_PATH, PENDING_DIFFS_TYPE, 'Pending voice diffs');
    // Seed the matched-draft guard from config (replaces the doc-derived extractMatchedDraftIds
    // scan). seedMatchedDraftIds is kept separate (immutable snapshot of what's persisted) from
    // alreadyMatchedDraftIds (the mutable in-run guard matchDraftToSent adds to below) so the
    // final write can be built from the seed + only-this-run's successfully diffed drafts,
    // deliberately excluding any draft matched-but-failed-to-fetch this run (see the write below).
    const seedMatchedDraftIds = await readIdSet(store, MATCHED_DRAFT_IDS_KEY, ctx.log);
    const alreadyMatchedDraftIds = new Set(seedMatchedDraftIds);
    // Seed the asked-guard from config (replaces the doc-derived extractAskedTaskIds scan).
    const alreadyAskedTaskIds = await readIdSet(store, ASKED_TASK_IDS_KEY, ctx.log);

    // Consider every open/in-progress CEO task for completion matching. listAllTasks walks
    // keyset pages so we no longer silently truncate at the old 100-task cap (#1433). If its
    // safety ceiling is hit, `truncated` is true — surface it here (and in the result) so a
    // partial task set is visible rather than mistaken for full coverage.
    const { tasks: openTasks, truncated: openTasksTruncated } = await ctx.taskRepo.listAllTasks({
      owner: 'ceo',
      statuses: ['open', 'in_progress'],
    });
    if (openTasksTruncated) {
      ctx.log.warn(
        { openTasksConsidered: openTasks.length },
        'ceo-inbox-sent-observe: open CEO task set hit the pagination safety ceiling — ' +
          'completion matching ran against a partial set; lowest-priority tasks past the ceiling were not considered',
      );
    }

    let draftMatches = 0;
    // Cleared to false if any draft's full Sent body can't be fetched. Holds the watermark (see
    // advanceOk) so the send is re-observed next run rather than persisting a diff built from a
    // truncated snippet — the same Finding-7 treatment the shadow-reconcile path already applies.
    let draftEvidenceComplete = true;
    let taskCandidates = 0;
    let shadowReconciled = 0;
    let maxDate = watermark;
    // Oldest message actually processed this run. Diagnostics only: it's surfaced as
    // `oldestScannedAt` in the truncation warning so an operator can see where the
    // skipped tail begins. The watermark still advances to maxDate + 1 on truncation
    // (see the watermark-advance block below) — minDate does NOT hold it back.
    let minDate = Number.POSITIVE_INFINITY;
    const diffChunks: string[] = [];
    // Drafts that actually got a diff persisted THIS run (as opposed to alreadyMatchedDraftIds,
    // which also gains a draftId on a matched-but-fetch-failed draft — see the message loop).
    // Only this set feeds the matched_draft_ids write below, so a failed-fetch draft is never
    // durably marked matched and can re-match on retry.
    const newlyDiffedDraftIds = new Set<string>();
    const newCandidates: CompletionCandidateMap = {};

    const shadowDocs = await ctx.workingDocs.listByPrefix(`${SHADOW_SCRATCH_PREFIX}/`);
    const shadows = shadowDocs
      .map((d) => parseShadowDoc(d))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    // (shadow, sent) pairs collected during the message loop below, judged in a
    // single batched LLM call after the loop instead of one call per pair.
    // Idempotency across runs is the shadow doc's reconciled_at marker (parseShadowDoc returns
    // null once set); within a run each shadow doc is yielded once by listByPrefix, so no in-run
    // claim set is needed — two distinct shadows answered by one CEO send are both scored.
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
        // Mark matched in-run (1:1 draft↔send) even if the fetch fails, so no other message in
        // this window re-matches the same draft. Cross-run retry is safe: we hold the watermark
        // AND don't persist a diff, so next run's alreadyMatchedDraftIds re-seed (from the diffs
        // doc) excludes this draft and it re-matches for a fresh fetch.
        alreadyMatchedDraftIds.add(draftMatch.draftId);
        try {
          const full = await client.getMessage(msg.id);
          sentBody = htmlToPlainText(full.body) || full.snippet || sentBody;
          fetchedBodies.set(msg.id, sentBody);
          // Only persist the diff and count the match once the full body is in hand — a diff
          // built from the truncated snippet would poison the voice proposal and, once written +
          // watermark-advanced, never be repaired.
          diffChunks.push(formatDiffBlock(draftMatch, sentBody));
          draftMatches += 1;
          newlyDiffedDraftIds.add(draftMatch.draftId);
        } catch (err) {
          draftEvidenceComplete = false;
          ctx.log.warn(
            { err, messageId: msg.id },
            'ceo-inbox-sent-observe: getMessage failed — holding watermark for draft evidence retry',
          );
        }
      }

      const taskMatches = matchTasksToSent(msg, openTasks, alreadyAskedTaskIds);
      for (const tm of taskMatches) {
        newCandidates[tm.taskId] = {
          messageId: tm.messageId,
          confidence: tm.confidence,
          reason: tm.reason,
          sentAt: tm.sentAt,
          subject: tm.sentSubject,
          recipients: tm.sentRecipients,
          taskTitle: tm.taskTitle,
        } satisfies CompletionCandidate;
        alreadyAskedTaskIds.add(tm.taskId);
        taskCandidates += 1;
      }
    }

    // Shadow-draft competence reconcile (#1426). Runs AFTER the message loop so each shadow
    // can be matched to the *nearest eligible* send across the whole window rather than the
    // first newest same-thread message (Finding 6). shadowReconcileOk gates the watermark:
    // any un-scored / un-reconciled shadow flips it false so the carrying Sent message is
    // re-observed next run (the stored watermark is maxDate+1, so holding it keeps that message
    // above the next poll's floor). Declared here (not at the batch loop) so a body-fetch failure
    // below can hold the watermark too.
    let shadowReconcileOk = true;
    if (ctx.actionLogRepo) {
      for (const shadow of shadows) {
        const send = selectShadowSend(shadow, messages);
        if (!send) continue;

        // Finding 7: never judge against a truncated snippet — the LLM would write a false
        // competence score. If the full sent body can't be fetched, don't push the pair and
        // hold the watermark so the send is re-observed next run.
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

    // Shadow-draft competence reconcile (#1419 / ADR-029): ONE LLM call per run over up to 40
    // pairs. A failed batch leaves those shadow docs' reconciled_at unset — but the stored
    // watermark is maxDate+1, so the carrying Sent message is only re-fetched next run if we
    // HOLD the watermark. shadowReconcileOk tracks that: anything short of a clean, complete
    // response flips it false and the watermark-advance guard below blocks the advance. Retry is
    // idempotent because already-reconciled shadows are skipped (parseShadowDoc returns null once
    // reconciled_at is set) and diff/completion matching is idempotent via the matched/asked sets.
    if (judgePairs.length > 0 && ctx.infraLlm && ctx.actionLogRepo) {
      const MAX_JUDGE = 40;
      const batch = judgePairs.slice(0, MAX_JUDGE);
      if (judgePairs.length > MAX_JUDGE) {
        // Overflow pairs stay unreconciled (reconciled_at unset) and retry next run; hold the
        // watermark so their carrying sends are re-observed.
        shadowReconcileOk = false;
        ctx.log.warn(
          { total: judgePairs.length, judged: MAX_JUDGE, dropped: judgePairs.length - MAX_JUDGE },
          'sent-observe: more than 40 shadow pairs — judging the first 40, the rest retry next run',
        );
      }

      const res = await ctx.infraLlm.extract(buildShadowJudgePrompt(batch), { maxTokens: 1500 });
      const judged = res.ok
        ? parseShadowJudgeResult(res.text, batch.map((p) => p.sourceMessageId))
        : null;

      // All-or-nothing: an LLM error, or a malformed / duplicate-id / incomplete response, fails
      // the WHOLE batch — write no rows, hold the watermark, retry next run.
      if (judged === null) {
        shadowReconcileOk = false;
        ctx.log.warn(
          { count: batch.length, error: res.ok ? 'malformed-or-incomplete-response' : res.error },
          'sent-observe: shadow judge failed or returned an unusable response — holding watermark',
        );
      } else {
        // Clean response — per-pair idempotent insert (#1432: migration-074 unique index is the
        // durable dedup) + reconciled_at mark (the efficiency guard that lets the watermark advance
        // and skips re-judging next run). A per-pair insert/mark failure holds the watermark for
        // that pair (it re-judges next run) without discarding the pairs that did land.
        for (const pair of batch) {
          const j = judged.get(pair.sourceMessageId)!; // strict parse guarantees exact coverage
          try {
            // Idempotent insert (#1432): the migration-074 partial unique index guarantees one
            // 'shadow_evaluated' row per source_message_id, so a re-run after a failed mark can't
            // double-score. A null return means the row already exists (recorded on a prior run) —
            // that's not an error; we still fall through to mark reconciled_at so the re-run
            // converges. Only a THROW holds the watermark.
            await ctx.actionLogRepo.insertShadowEvaluated({
              taskId: ctx.taskEventId ?? `shadow:${j.sourceMessageId}`,
              conversationId: ctx.conversationId,
              toolName: 'shadow-draft-eval',
              actionRisk: 'none',
              outcome: 'shadow_evaluated',
              taskSummary: `Shadow vs sent (${j.sourceMessageId}): ${j.reason}`,
              payload: { shadow: true, source_message_id: j.sourceMessageId, competence_reason: j.reason },
              competenceFlag: j.sameDecision ? 1 : 0,
              scoredBy: 'shadow-reconciler',
            });
          } catch (err) {
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
            shadowReconcileOk = false;
            ctx.log.warn(
              { sourceMessageId: j.sourceMessageId },
              'sent-observe: shadow doc missing at mark time — holding watermark',
            );
            continue;
          }
          // The autonomy_action_log row inserted above is the authoritative competence signal
          // for scoring (dedup'd by the #1432 unique index). This frontmatter competence_flag
          // is informational only — it may reflect a later re-judge that a deduped (ON CONFLICT
          // DO NOTHING) DB row never recorded, so don't treat it as a source of truth.
          const upd = await ctx.workingDocs.update(path, {
            frontmatter: { ...doc.frontmatter, reconciled_at: new Date().toISOString(), competence_flag: j.sameDecision ? 1 : 0 },
            expectedVersion: doc.version,
          });
          if (!upd.ok) {
            shadowReconcileOk = false;
            ctx.log.warn(
              { sourceMessageId: j.sourceMessageId },
              'sent-observe: shadow doc mark update conflict — holding watermark',
            );
            continue;
          }
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
    // Persist matched_draft_ids only when the diffs doc persisted. Include drafts whose diff
    // actually landed this run (newlyDiffedDraftIds); EXCLUDE any whose body-fetch failed (never
    // diffed) so they re-match next run — mirroring the old re-derive-from-pending-diffs behavior.
    // Prune the carried-over set to drafts whose snapshot still exists (a snapshot TTL-sweeps
    // after 7 idle days; once gone it can't be re-matched, so retaining its id is pointless).
    // Tracks whether the matched-draft guard write itself landed. Unlike the old doc-derived
    // guard (which re-derived matched ids from the pending-diffs doc body on every run), the
    // guard is now standalone config with no fallback — extractMatchedDraftIds was deleted.
    // A lost write here means the NEXT run's seed is stale (missing this run's newly-diffed
    // drafts), so matchDraftToSent could re-match an already-diffed draft and append a
    // duplicate diff block. Holding the watermark on a soft-reject/throw re-observes the same
    // Sent message next run, which re-derives and re-writes the guard from scratch.
    let matchedGuardPersisted = true;
    if (diffsPersisted) {
      const snapshotIds = new Set(snapshots.map((s) => s.draftId));
      const nextMatched = new Set([...seedMatchedDraftIds].filter((id) => snapshotIds.has(id)));
      for (const id of newlyDiffedDraftIds) nextMatched.add(id);
      try {
        matchedGuardPersisted = await writeIdSet(store, MATCHED_DRAFT_IDS_KEY, nextMatched);
        if (!matchedGuardPersisted) {
          ctx.log.warn(
            { path: MATCHED_DRAFT_IDS_KEY },
            'ceo-inbox-sent-observe: matched-guard write soft-rejected — holding watermark for retry',
          );
        }
      } catch (err) {
        matchedGuardPersisted = false;
        ctx.log.warn(
          { err },
          'ceo-inbox-sent-observe: matched-guard write failed — holding watermark for retry',
        );
      }
    }
    // Persist the candidate queue (config JSON) — replaces the pending-completions.md append.
    // Merge onto a fresh read so we don't clobber a concurrent removal by task-completion; keyed
    // by taskId so a held-watermark retry re-adds idempotently. completionsPersisted is driven by
    // the accessor's own boolean return (not just the catch path) so a storeFact SOFT-reject
    // (dedup 'conflict'/'auto_rejected', result.stored===false with no thrown error) also holds
    // the watermark for retry — a caught-error-only gate would silently advance past a lost write.
    let completionsPersisted = true;
    if (Object.keys(newCandidates).length > 0) {
      try {
        const existing = await readCompletionCandidates(store, ctx.log);
        completionsPersisted = await writeCompletionCandidates(store, { ...existing, ...newCandidates });
        if (!completionsPersisted) {
          ctx.log.warn(
            { path: COMPLETION_CANDIDATES_KEY },
            'ceo-inbox-sent-observe: completion-candidate write soft-rejected (not persisted) — holding watermark for retry',
          );
        }
      } catch (err) {
        completionsPersisted = false;
        ctx.log.warn({ err }, 'ceo-inbox-sent-observe: completion-candidate write failed — holding watermark');
      }
    }

    // Persist the asked-task guard AFTER the queue, and only when the queue persisted — writing
    // the guard while the queue write failed would let next run skip re-matching and LOSE the
    // candidate. Runs whenever completionsPersisted, independent of the watermark-advance
    // decision below (a held watermark that still persisted the queue still wants a fresh guard).
    // Prune to currently-open tasks (Joseph's retention choice): a completed/cancelled task drops
    // out of the guard; re-surfacing a since-reopened task is harmless (original send is below the
    // watermark; task-completion re-validates eligibility).
    // Same standalone-config reasoning as matchedGuardPersisted above: the asked-guard has no
    // OKF-derived fallback either, so a lost write here means next run's seed is stale (missing
    // this run's newly-asked task ids), and matchTasksToSent could re-match a task that already
    // has a queued candidate — re-asking about it. Holding the watermark re-observes the
    // carrying Sent message next run, which re-derives and re-writes the guard from scratch.
    let askedGuardPersisted = true;
    if (completionsPersisted) {
      const openIds = new Set(openTasks.map((t) => t.id));
      const prunedAsked = new Set([...alreadyAskedTaskIds].filter((id) => openIds.has(id)));
      try {
        askedGuardPersisted = await writeIdSet(store, ASKED_TASK_IDS_KEY, prunedAsked);
        if (!askedGuardPersisted) {
          ctx.log.warn(
            { path: ASKED_TASK_IDS_KEY },
            'ceo-inbox-sent-observe: asked-guard write soft-rejected — holding watermark for retry',
          );
        }
      } catch (err) {
        askedGuardPersisted = false;
        ctx.log.warn(
          { err },
          'ceo-inbox-sent-observe: asked-guard write failed — holding watermark for retry',
        );
      }
    }

    // If evidence didn't reach OKF/config, hold the watermark so those messages are re-observed
    // next run (matching is idempotent via the already-matched/asked sets seeded above, so the
    // successful writes won't duplicate).
    const evidencePersisted = diffsPersisted && completionsPersisted;
    // The watermark may only advance when the rolling evidence persisted AND every shadow batch
    // reconciled AND every matched draft's full body was fetched AND both standalone guard
    // writes (matched-draft, asked-task) landed. Any of these failing holds the watermark so the
    // carrying Sent message is re-observed next run instead of being stranded past the
    // `received_after` floor (an orphaned shadow doc is otherwise TTL-swept after 7 idle days; a
    // truncated draft diff would otherwise persist unrepaired; a lost guard write would otherwise
    // let a draft/task double-surface on a later run since neither guard re-derives from OKF any
    // more — extractMatchedDraftIds/extractAskedTaskIds were both deleted in #1438).
    const advanceOk =
      evidencePersisted && shadowReconcileOk && draftEvidenceComplete && matchedGuardPersisted && askedGuardPersisted;

    // Watermark / backfill state transition (#1431).
    //
    // Nylas `received_after`/`received_before` are INCLUSIVE Unix-second bounds, and Nylas returns
    // newest-first — so a single forward floor can only ever walk *forward*, and on truncation the
    // un-fetched messages are the OLDEST in the window (date < minDate). To drain a >SENT_MAX_SCAN
    // backlog without stranding that tail we keep the watermark PINNED at its floor and walk a
    // descending `received_before` ceiling (backfillBefore) down toward it across runs, jumping the
    // watermark to backfillTarget + 1 only once the oldest sub-window is drained. That way the
    // watermark never sits above an un-drained message.
    //
    // `advanceOk` still gates everything: any evidence-persist / shadow / guard failure holds ALL
    // state (no watermark move, no backfill-key move) so the same window is re-observed next run
    // (matching is idempotent via the already-matched/asked/reconciled guards).
    let watermarkAdvancedTo: number | null = null;
    // True after this run if a drain is still underway (fed to the caller/logs).
    let backfillStillActive = backfillActive;
    if (advanceOk) {
      if (backfillActive) {
        if (messages.length > 0 && truncated) {
          // Still an older tail below minDate — descend the ceiling; watermark stays pinned.
          // minDate is INCLUSIVE, so the boundary second is re-scanned next run; this guarantees a
          // same-second group split by the SENT_MAX_SCAN ceiling is never lost (the re-scan is
          // idempotent via the matched/asked/reconciled guards). Progress is guaranteed because
          // truncation means messages strictly older than minDate exist, so the next scan yields a
          // strictly lower minDate — barring ≥500 sends in one second, impossible for one Sent box.
          // ConfigStore.set can SOFT-REJECT (stored:false) without throwing (#1438); a lost descend
          // just re-scans the same window next run (idempotent), but we log it so a stalled drain
          // (ceiling never moving) is visible rather than silent.
          const res = await store.set(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY, String(minDate));
          if (!res.stored) {
            ctx.log.warn(
              { floor: watermark, ceiling: backfillBefore, nextCeiling: minDate },
              'ceo-inbox-sent-observe: backfill ceiling descend not persisted — re-scanning same window next run',
            );
          }
          backfillStillActive = true;
        } else if (truncated) {
          // Anomalous empty page carrying a lingering cursor: listAllMessages reports
          // truncated=true with zero messages (see its "empty page with a cursor" guard), and its
          // comment is explicit that this must NOT be read as a fully-drained window. With no
          // messages there's no new minDate to descend to, so hold everything — no watermark jump,
          // no key clear — and retry next run, exactly like the !advanceOk path. Completing here
          // would strand the un-walked tail, the precise failure this drain exists to prevent.
          ctx.log.warn(
            { floor: watermark, ceiling: backfillBefore },
            'ceo-inbox-sent-observe: backfill page reported truncated with zero messages — holding, retrying next run',
          );
          backfillStillActive = true;
        } else {
          // Drain complete (window fully scanned, or emptied by deletions). Jump the watermark past
          // the newest date captured when the backlog was detected, then clear the backfill keys.
          // Math.max(watermark, backfillTarget) FLOOR-GUARDS the jump: the watermark must never move
          // backward, so even a desynced/lost target (read as 0 after a soft-rejected write) advances
          // to the pinned floor + 1 — triggering a fresh forward re-scan (idempotent), never a reset
          // to epoch. Each write is checked (#1438): the drain only counts as finished once the
          // BACKFILL_BEFORE key actually clears, so a lost clear re-completes next run (empty window,
          // monotonically increasing watermark) instead of silently stranding an active-but-stale drain.
          watermarkAdvancedTo = Math.max(watermark, backfillTarget) + 1;
          const wRes = await store.set(CONFIG_NAMESPACE, WATERMARK_KEY, String(watermarkAdvancedTo));
          const bRes = await store.set(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY, EPOCH);
          const tRes = await store.set(CONFIG_NAMESPACE, BACKFILL_TARGET_KEY, EPOCH);
          backfillStillActive = !bRes.stored; // still "active" next run if the ceiling didn't clear
          if (!wRes.stored || !bRes.stored || !tRes.stored) {
            ctx.log.warn(
              { watermarkStored: wRes.stored, beforeCleared: bRes.stored, targetCleared: tRes.stored, watermarkAdvancedTo },
              'ceo-inbox-sent-observe: backfill completion writes only partially persisted — will reconcile next run',
            );
          }
        }
      } else if (messages.length > 0) {
        if (truncated && watermark > 0) {
          // A real gap above a known floor exceeded the scan ceiling: begin an oldest-first drain.
          // Record the newest date (the watermark jumps here on completion) and set the first
          // ceiling to this batch's oldest. The watermark is NOT advanced — it stays the drain's
          // floor, so it never sits above an un-drained message.
          //
          // Order + guard matters (#1438): the TARGET write can SOFT-REJECT (stored:false) — e.g.
          // overwriting the EPOCH sentinel a prior drain left. We write TARGET first and only set the
          // BEFORE ceiling once TARGET has actually landed, so the drain can never become active with
          // a missing target (the (before>0, target=0) state that would later reset the watermark to
          // epoch on completion). If TARGET doesn't land, we hold: the watermark is already pinned, so
          // next run re-scans the same truncated window and retries entry.
          const tRes = await store.set(CONFIG_NAMESPACE, BACKFILL_TARGET_KEY, String(maxDate));
          const bRes = tRes.stored
            ? await store.set(CONFIG_NAMESPACE, BACKFILL_BEFORE_KEY, String(minDate))
            : { stored: false };
          backfillStillActive = bRes.stored;
          if (!tRes.stored || !bRes.stored) {
            ctx.log.warn(
              { targetStored: tRes.stored, ceilingStored: bRes.stored, maxDate, minDate },
              'ceo-inbox-sent-observe: could not fully persist backfill entry — watermark held, retrying next run',
            );
          }
        } else {
          // Normal forward advance to newest + 1 (mirrors the inbound email adapter's
          // `this.lastSeenTimestamp = msg.date + 1`). Covers the non-truncated steady state AND the
          // first-ever run (watermark 0): forward-only observation — historical mail is
          // intentionally NOT backfilled (a forward-looking observer; confirmed product decision).
          watermarkAdvancedTo = maxDate + 1;
          await store.set(CONFIG_NAMESPACE, WATERMARK_KEY, String(watermarkAdvancedTo));
        }
      }
    } else if (messages.length > 0) {
      const holdReason = !evidencePersisted
        ? 'ceo-inbox-sent-observe: evidence persistence failed — holding watermark for retry'
        : !draftEvidenceComplete
          ? 'ceo-inbox-sent-observe: draft body fetch failed — holding watermark for retry'
          : !shadowReconcileOk
            ? 'ceo-inbox-sent-observe: shadow reconcile failed — holding watermark for retry'
            : 'ceo-inbox-sent-observe: guard write failed — holding watermark for retry';
      ctx.log.warn(
        {
          path: PENDING_DIFFS_PATH,
          evidencePersisted,
          shadowReconcileOk,
          draftEvidenceComplete,
          matchedGuardPersisted,
          askedGuardPersisted,
        },
        holdReason,
      );
    }

    // Truncation is loud until the backlog is drained (#1431). With a real floor it means a drain is
    // in progress (older tail still to come); on the first-ever run (watermark 0) it means history
    // is intentionally skipped.
    if (truncated) {
      if (watermark > 0) {
        ctx.log.warn(
          {
            scanned: messages.length,
            maxScan: SENT_MAX_SCAN,
            floor: watermark,
            ceiling: backfillActive ? backfillBefore : null,
            nextCeiling: Number.isFinite(minDate) ? minDate : null,
            backfillTarget: backfillActive ? backfillTarget : maxDate,
          },
          `ceo-inbox-sent-observe: Sent window exceeded the ${SENT_MAX_SCAN}-message scan ceiling — ` +
            'draining the older tail oldest-first across successive runs (backfill in progress).',
        );
      } else {
        ctx.log.warn(
          {
            scanned: messages.length,
            maxScan: SENT_MAX_SCAN,
            advancedTo: watermarkAdvancedTo,
          },
          `ceo-inbox-sent-observe: first run against a large mailbox exceeded the ${SENT_MAX_SCAN}-message ` +
            'scan ceiling — observing forward-only; historical mail is intentionally not backfilled.',
        );
      }
    }

    // A mid-drain empty window is not "idle" — it completes the drain (handled above), so only a
    // genuinely empty forward poll registers the idle backoff.
    if (messages.length === 0 && !backfillActive) {
      await store.set(CONFIG_NAMESPACE, IDLE_BACKOFF_KEY, String(nowMs));
    } else {
      await store.set(CONFIG_NAMESPACE, IDLE_BACKOFF_KEY, EPOCH);
    }

    ctx.log.info(
      {
        messagesScanned: messages.length,
        draftMatches,
        taskCandidates,
        shadowReconciled,
        watermarkAdvancedTo,
        backfillStillActive,
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
        backfill_active: backfillStillActive,
        // True when the open-task set exceeded the pagination safety ceiling, so task-completion
        // matching this run considered only a partial set (#1433).
        tasks_truncated: openTasksTruncated,
        skipped_backoff: false,
      },
    };
  }
}
