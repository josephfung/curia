// handler.ts — contact-find-duplicates skill
//
// The weekly dedup scan. For every candidate pair it either merges the pair itself or
// files one Curia-owned review task, then returns a summary (it never returns the raw
// pair list, so a run cannot flood the agent context or time out). #2493 made it
// mostly self-driving:
//
//   1. Settle the open queue first (src/contacts/dedup-tasks.ts): close tasks whose pair
//      is already merged, excluded or filed twice, hand Curia's pairs back from the
//      principal, reopen tasks blocked on a closed task.
//   2. Classify each pair (classifyPair). A structural pair that canAutoMerge allows is
//      merged here, audited with the classifier's reason. That needs the live autonomy
//      score to clear the bar contact-merge itself needs on an autonomous task (medium,
//      70); below it, or with no autonomy service, the pair is filed for review instead.
//   3. File a review task for each remaining pair at or above min_score, tagged with its
//      route (dedupReviewRoute): Curia decides it, or it may go to the principal.
//
// Re-filing: a pair is skipped when it has an open task, an exclusion, or a review task
// that closed within DEFERRAL_COOLDOWN_DAYS. A deferral writes no exclusion by design, so
// the cooldown is what stops the same pair returning every Monday; it ends early when
// either contact's name or identities change (the dedup-fp tag no longer matches).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { ChannelIdentity, Contact, DuplicatePair, TaskOriginator } from '../../../../src/contacts/types.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';
import { AutonomyService } from '../../../../src/autonomy/autonomy-service.js';
import { isStructuralContact } from '../../../../src/contacts/contact-service.js';
import { classifyPair, type PairClassification } from '../../../../src/contacts/dedup-classifier.js';
import {
  canonicalPairKey,
  dedupPairTag,
  pairKeyFromDedupTask,
} from '../../../../src/contacts/dedup-pair-key.js';
import {
  canAutoMerge,
  choosePrimary,
  dedupFingerprintTag,
  dedupPairFingerprint,
  dedupReviewRoute,
  dedupRouteTag,
  fingerprintFromTags,
  type DedupRoute,
} from '../../../../src/contacts/dedup-routing.js';
import {
  OPEN_DEDUP_TASK_STATUSES,
  TERMINAL_DEDUP_TASK_STATUSES,
  closeDedupTasksForMergedContact,
  reconcileOpenDedupTasks,
} from '../../../../src/contacts/dedup-tasks.js';

// Default minimum Jaro-Winkler score — chosen empirically as the precision sweet
// spot on the production contact set (0.95 is very clean, 0.90 starts to pick up
// same-surname false positives, 0.7 is the DedupService base floor). See #1037.
// Structural pairs are merged whatever their score; this gates review tasks only.
const DEFAULT_MIN_SCORE = 0.93;

// Upper bound on how many dedup tasks we load per status group for the idempotency and
// cooldown checks. With max_tasks=20 and a weekly cadence, 1000 open tasks would need
// ~50 weeks with zero resolution, and 1000 closed within the cooldown ~50 a week.
// listTasks has no offset support; a hit is logged rather than silently trusted.
const TASK_FETCH_LIMIT = 1000;

/** How long a closed review keeps its pair from being filed again (#2493). */
export const DEFERRAL_COOLDOWN_DAYS = 56;

/** Ceiling on automatic merges per run — a safety valve against a classifier bug. */
const DEFAULT_MAX_AUTO_MERGES = 25;
/** Review tasks filed per scan when the caller passes no max_tasks. */
const DEFAULT_MAX_TASKS = 20;

/** Who the contact.merged audit row names as the decider of an automatic merge. */
const AUTO_MERGE_ACTOR = 'dedup-scan';

/** Review tasks for one pair that closed within the cooldown. */
interface ClosedReviews {
  /** Fingerprints the pair had when each of those tasks was filed. */
  fingerprints: Set<string>;
  /** A task filed before #2493 carries no fingerprint: it holds the pair for the full cooldown. */
  legacy: boolean;
}

interface AutoMergeGate {
  enabled: boolean;
  /** Why auto-merge is off, for the summary. Absent when enabled. */
  reason?: string;
}

export class ContactFindDuplicatesHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { min_score: rawMinScore, max_tasks: rawMaxTasks } = ctx.input as {
      min_score?: unknown;
      max_tasks?: unknown;
    };

    const minScore = rawMinScore !== undefined ? Number(rawMinScore) : DEFAULT_MIN_SCORE;
    const maxTasks = rawMaxTasks !== undefined ? Number(rawMaxTasks) : DEFAULT_MAX_TASKS;

    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      return { success: false, error: `Invalid min_score "${rawMinScore}": must be a number between 0 and 1.` };
    }
    if (maxTasks !== undefined && (!Number.isFinite(maxTasks) || maxTasks < 0 || !Number.isInteger(maxTasks))) {
      return { success: false, error: `Invalid max_tasks "${rawMaxTasks}": must be a non-negative integer.` };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-find-duplicates: contactService not available — check ExecutionLayer configuration.',
      };
    }
    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'contact-find-duplicates: taskRepo not available — declare "taskRepo" in capabilities.',
      };
    }

    // Capture as local variables so closures below don't need non-null assertions.
    const taskRepo = ctx.taskRepo;
    const contactService = ctx.contactService;

    ctx.log.info({ minScore, maxTasks }, 'contact-find-duplicates: starting scan');

    // -- Setup phase: failures here abort the scan entirely before any writes --
    let allPairs: DuplicatePair[];
    let contactsById: Map<string, Contact>;
    let openTasks: TaskRow[];
    let recentlyClosed: Map<string, ClosedReviews>;
    let excludedPairKeys: Set<string>;
    try {
      // Every pair at the base floor (0.7): structural pairs are acted on whatever their
      // score, and review tasks are filtered to min_score below.
      allPairs = await contactService.findDuplicates('probable');
      // classifyPair and the routing rules need kind, tier, role, system role and age,
      // which DuplicatePair does not carry. One list call, keyed by id.
      contactsById = new Map((await contactService.listContacts()).map(c => [c.id.toLowerCase(), c]));

      openTasks = await taskRepo.listTasks({
        statuses: OPEN_DEDUP_TASK_STATUSES,
        tag: 'dedup',
        limit: TASK_FETCH_LIMIT,
      });
      const cooldownStart = new Date(Date.now() - DEFERRAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
      const closedTasks = await taskRepo.listTasks({
        statuses: TERMINAL_DEDUP_TASK_STATUSES,
        tag: 'dedup',
        updatedAfter: cooldownStart,
        limit: TASK_FETCH_LIMIT,
      });
      if (openTasks.length >= TASK_FETCH_LIMIT) {
        ctx.log.warn(
          { count: openTasks.length, limit: TASK_FETCH_LIMIT, group: 'open' },
          'contact-find-duplicates: task fetch hit limit — some pairs may be re-filed',
        );
      }
      // A truncated cooldown ledger would let a deferred pair be filed again inside its
      // cooldown, so stop the scan rather than file against an incomplete ledger.
      if (closedTasks.length >= TASK_FETCH_LIMIT) {
        throw new Error(
          `more than ${TASK_FETCH_LIMIT - 1} dedup reviews closed within ${DEFERRAL_COOLDOWN_DAYS} days; `
          + 'the cooldown ledger would be incomplete',
        );
      }
      recentlyClosed = new Map();
      for (const task of closedTasks) {
        const key = pairKeyFromDedupTask(task);
        if (!key) continue;
        const entry = recentlyClosed.get(key) ?? { fingerprints: new Set<string>(), legacy: false };
        const fingerprint = fingerprintFromTags(task.tags);
        if (fingerprint) entry.fingerprints.add(fingerprint);
        else entry.legacy = true;
        recentlyClosed.set(key, entry);
      }

      // Load every exclusion once instead of one lookup per pair. A failure aborts the
      // scan rather than silently re-filing (or auto-merging) excluded pairs.
      excludedPairKeys = await contactService.listDedupExclusionPairKeys();
      ctx.log.info({ exclusions: excludedPairKeys.size }, 'contact-find-duplicates: loaded dedup exclusions');

      const unparseable = openTasks.filter(t => pairKeyFromDedupTask(t) === null).length;
      if (unparseable > 0) {
        // Dedup-tagged tasks without parseable contact IDs (manually created, old format,
        // or truncated description) are invisible to the idempotency check — those pairs
        // may be re-filed. Operators can fix by adding "Contact A/B ID: <uuid>" lines
        // to the description, or removing the 'dedup' tag to suppress this warning.
        ctx.log.warn(
          { count: unparseable },
          'contact-find-duplicates: some dedup-tagged tasks have no parseable contact IDs — those pairs may be re-filed',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'contact-find-duplicates: setup phase failed (findDuplicates, listContacts, listTasks, or exclusion load)');
      return { success: false, error: `Failed to scan for duplicates: ${message}` };
    }

    const gate = await this.autoMergeGate(ctx);

    // -- Phase 1: settle the open queue --
    // Best-effort: per-task errors are counted inside. Anything else is logged and the
    // scan carries on with every open task's pair treated as still open, so nothing is
    // filed twice.
    let reconciled: Awaited<ReturnType<typeof reconcileOpenDedupTasks>>;
    try {
      reconciled = await reconcileOpenDedupTasks({
        taskRepo, openTasks, contactsById, excludedPairKeys, log: ctx.log,
      });
    } catch (err) {
      ctx.log.error({ err }, 'contact-find-duplicates: queue reconciliation failed — continuing without it');
      const openPairKeys = new Set<string>();
      for (const task of openTasks) {
        const key = pairKeyFromDedupTask(task);
        if (key) openPairKeys.add(key);
      }
      reconciled = { closed: 0, reassigned: 0, unblocked: 0, failed: 1, openPairKeys };
    }
    const existingPairKeys = reconciled.openPairKeys;

    let autoMerged = 0;
    let autoMergeFailed = 0;
    let autoMergeCapped = 0;
    let filed = 0;
    let filedForPrincipal = 0;
    let skippedExisting = 0;
    let skippedExcluded = 0;
    let skippedRecent = 0;
    let skippedMerged = 0;
    let skippedProtected = 0;
    let capped = 0;
    let failed = 0;
    let tasksClosedByMerges = 0;
    let considered = 0;

    // Contacts merged (either side) during this run. Their snapshot rows are stale — the
    // survivor's tier, name and identities just changed — so any later pair touching one
    // waits for next week's scan, which sees the merged record.
    const touchedThisRun = new Set<string>();

    // -- Phase 2: per pair. Errors are isolated so one failing pair doesn't abort the scan --
    for (const pair of allPairs) {
      const aId = pair.contactA.id.toLowerCase();
      const bId = pair.contactB.id.toLowerCase();
      const key = canonicalPairKey(aId, bId);
      const a = contactsById.get(aId);
      const b = contactsById.get(bId);

      // Created after the snapshot, or deleted since findDuplicates read it: next run.
      if (!a || !b) continue;

      // canonicalPairKey matches the order-independent key listDedupExclusionPairKeys
      // returns, so a pair excluded in either direction is caught here. An exclusion
      // also blocks an automatic merge: a recorded "not the same person" wins.
      const excluded = excludedPairKeys.has(key);
      let classification: PairClassification;
      try {
        // classifyPair scores the pair directly (no name blocking), so it can only return
        // null where it disagrees with the scan's own scoring. The pair is still a fuzzy
        // candidate on the scan's score; it is never structural.
        classification = classifyPair(a, pair.contactA.identities, b, pair.contactB.identities)
          ?? { type: 'fuzzy', score: pair.score, reason: pair.reason };
      } catch (err) {
        failed++;
        ctx.log.error({ err, contactAId: aId, contactBId: bId }, 'contact-find-duplicates: classifyPair threw — skipping pair');
        continue;
      }

      // Structural pairs are acted on whatever their score (review or merge); fuzzy pairs
      // only at or above min_score.
      if (classification.type === 'fuzzy' && pair.score < minScore) continue;
      considered++;

      if (touchedThisRun.has(aId) || touchedThisRun.has(bId)) {
        skippedMerged++;
        continue;
      }

      // A pair with a protected contact (the principal, an agent, a system role) has no
      // merge route: contact-merge refuses it and the console offers none, so a review
      // task would only be one nobody can resolve. Skipped, not filed (#2493).
      if (isStructuralContact(a) || isStructuralContact(b)) {
        skippedProtected++;
        continue;
      }

      // A deferred pair stays quiet for the cooldown unless either contact changed since the
      // closed task was filed (its fingerprint no longer matches). A legacy task (no
      // fingerprint) holds it for the full cooldown. Applies to auto-merge as well as filing,
      // so raising the autonomy score mid-deferral does not override the deferral.
      const fingerprint = dedupPairFingerprint(a, idsFor(pair, aId), b, idsFor(pair, bId));
      const closed = recentlyClosed.get(key);
      if (!excluded && closed && (closed.legacy || closed.fingerprints.has(fingerprint))) {
        skippedRecent++;
        continue;
      }

      if (classification.type === 'structural' && !excluded && gate.enabled && canAutoMerge(a, b, classification)) {
        if (autoMerged >= DEFAULT_MAX_AUTO_MERGES) {
          autoMergeCapped++;
          continue;
        }
        const { primary, secondary } = choosePrimary(
          a, idsFor(pair, aId), b, idsFor(pair, bId),
        );
        try {
          await contactService.mergeContacts(primary.id, secondary.id, false, {
            reason: `Dedup scan auto-merge (${classification.reason})`,
            mergedBy: AUTO_MERGE_ACTOR,
            requireSameTier: true,
          });
          autoMerged++;
          touchedThisRun.add(primary.id.toLowerCase());
          touchedThisRun.add(secondary.id.toLowerCase());
          // A review task may already be open for this pair or for a sibling naming the
          // contact just folded away; none of them has anything left to decide.
          tasksClosedByMerges += await closeDedupTasksForMergedContact(
            taskRepo,
            { survivorId: primary.id, secondaryId: secondary.id, survivorName: primary.displayName },
            ctx.log,
            { includeMergedPair: true },
          );
          ctx.log.info(
            {
              primaryContactId: primary.id,
              secondaryContactId: secondary.id,
              proof: classification.proof,
              reason: classification.reason,
            },
            'contact-find-duplicates: auto-merged structural pair',
          );
        } catch (err) {
          // The merge is one transaction, so a failure changed nothing. Next run retries.
          autoMergeFailed++;
          ctx.log.error(
            { err, primaryContactId: primary.id, secondaryContactId: secondary.id },
            'contact-find-duplicates: auto-merge failed — pair left as is, retried next run',
          );
        }
        continue;
      }

      // Review path: fuzzy pairs, and structural pairs that may not be auto-merged.
      if (existingPairKeys.has(key)) {
        skippedExisting++;
        continue;
      }
      if (excluded) {
        skippedExcluded++;
        continue;
      }

      if (maxTasks !== undefined && filed >= maxTasks) {
        capped++;
        continue;
      }

      const route = dedupReviewRoute(a, b);
      try {
        await taskRepo.createTask({
          agentId: 'contacts',
          title: `Review possible duplicate: ${a.displayName} / ${b.displayName}`,
          description: reviewDescription(a, b, classification, pair.score, route),
          owner: 'curia',
          source: 'agent',
          sourceAgentId: 'contacts',
          tags: [
            'dedup', 'contacts',
            dedupPairTag(aId, bId),
            dedupRouteTag(route),
            dedupFingerprintTag(fingerprint),
          ],
          // Copy the cron run's lineage (system) onto the review task (#1125). As a source='agent'
          // task it is a DERIVED child, so when the heartbeat wakes it the bypass ladder requires
          // posture D (score >= 90) to retain system standing — below that it is propose-only and
          // surfaces an approval request instead of auto-executing.
          originator: (ctx.taskMetadata?.originator as TaskOriginator | undefined) ?? null,
        });

        ctx.log.debug(
          { contactAId: aId, contactBId: bId, score: pair.score, route },
          'contact-find-duplicates: filed review task',
        );
        filed++;
        if (route === 'principal') filedForPrincipal++;
        existingPairKeys.add(key);
      } catch (taskErr) {
        // Fail open: log and continue so one pair error doesn't abort the entire scan.
        // The pair is not counted as filed, so the next weekly run attempts it again.
        failed++;
        ctx.log.error(
          { taskErr, contactAId: aId, contactBId: bId },
          'contact-find-duplicates: error filing task for pair — skipping and continuing',
        );
      }
    }

    const summary = {
      auto_merged: autoMerged,
      auto_merge_failed: autoMergeFailed,
      auto_merge_capped: autoMergeCapped,
      auto_merge_enabled: gate.enabled,
      ...(gate.reason && { auto_merge_disabled_reason: gate.reason }),
      filed,
      filed_for_principal: filedForPrincipal,
      skipped_existing: skippedExisting,
      skipped_excluded: skippedExcluded,
      skipped_recently_decided: skippedRecent,
      skipped_merged_this_run: skippedMerged,
      skipped_protected: skippedProtected,
      capped,
      failed: failed + reconciled.failed,
      tasks_closed: reconciled.closed + tasksClosedByMerges,
      tasks_handed_back: reconciled.reassigned,
      tasks_unblocked: reconciled.unblocked,
      total_scanned: considered,
    };
    ctx.log.info(summary, 'contact-find-duplicates: scan complete');
    return { success: true, data: summary };
  }

  /**
   * Automatic merges need the live autonomy score to clear the bar contact-merge needs on
   * an autonomous task (action_risk medium). Fails closed: no service, no config row, or
   * a read error all mean the pair is filed for review instead.
   */
  private async autoMergeGate(ctx: ToolContext): Promise<AutoMergeGate> {
    if (!ctx.autonomyService) return { enabled: false, reason: 'autonomy service unavailable' };
    try {
      const config = await ctx.autonomyService.getConfig();
      if (!config) return { enabled: false, reason: 'autonomy score not configured' };
      const required = AutonomyService.minScoreForActionRisk('medium');
      if (config.score < required) {
        return { enabled: false, reason: `autonomy score ${config.score} is below ${required}` };
      }
      return { enabled: true };
    } catch (err) {
      ctx.log.warn({ err }, 'contact-find-duplicates: autonomy read failed — auto-merge off for this run');
      return { enabled: false, reason: 'autonomy score could not be read' };
    }
  }
}

function idsFor(pair: DuplicatePair, contactId: string): ChannelIdentity[] {
  return pair.contactA.id.toLowerCase() === contactId ? pair.contactA.identities : pair.contactB.identities;
}

// The routing instruction travels on the task itself (ADR-046 rung 2: injection with its
// trigger), so the always-on prompt only has to say "follow the task's Decision line".
const ROUTE_LINES: Record<DedupRoute, string> = {
  curia:
    'Decision: yours. No person the principal has vouched for is on this pair, and merging '
    + 'changes no one\'s trust tier, so do not ask the principal. Merge them, or record them '
    + 'as not duplicates with contact-dedup-exclude (decided_by "curia").',
  principal:
    'Decision: ask the principal unless independent verified identity evidence proves the '
    + 'contacts are the same. A shared company kg_node_id or a sender-selected name is not '
    + 'conclusive identity evidence.',
};

function reviewDescription(
  a: Contact,
  b: Contact,
  classification: PairClassification,
  score: number,
  route: DedupRoute,
): string {
  const side = (c: Contact) => `${c.kind}, tier ${c.tier}`;
  return [
    `Possible duplicate contacts detected by the dedup skill scan.`,
    ``,
    `Contact A ID: ${a.id}  (${a.displayName}; ${side(a)})`,
    `Contact B ID: ${b.id}  (${b.displayName}; ${side(b)})`,
    ``,
    `Match type: ${classification.type}`,
    `Reason: ${classification.reason}`,
    `Score: ${score.toFixed(3)}`,
    ``,
    ROUTE_LINES[route],
  ].join('\n');
}
