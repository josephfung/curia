// handler.ts — contact-find-duplicates skill
//
// Scans all contacts for duplicate pairs above a numeric score threshold,
// files Curia-owned review tasks for qualifying pairs, and returns a summary.
// This is the scheduled-scan entry point: it files tasks (rather than returning
// a raw list) so a single run never floods the agent context or causes a timeout.
//
// Idempotency: pairs that already have an open 'dedup' task, or that have a
// dedup_exclusion KG fact in either direction, are skipped and counted in the
// summary. This makes repeated weekly runs safe to run without accumulating
// duplicate tasks.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { DuplicatePair, TaskOriginator } from '../../src/contacts/types.js';
import type { KgNode } from '../../src/memory/types.js';
import { hasExclusion } from '../../src/contacts/dedup-exclusions.js';
import {
  canonicalPairKey,
  dedupPairTag,
  pairKeyFromDedupTask,
} from '../../src/contacts/dedup-pair-key.js';

// Default minimum Jaro-Winkler score — chosen empirically as the precision sweet
// spot on the production contact set (0.95 is very clean, 0.90 starts to pick up
// same-surname false positives, 0.7 is the DedupService base floor). See #1037.
const DEFAULT_MIN_SCORE = 0.93;

// Statuses that constitute an "open" task for idempotency purposes.
const OPEN_STATUSES = ['open', 'in_progress', 'waiting', 'blocked'];

// Upper bound on how many open dedup tasks we load for the idempotency check.
// With max_tasks=20 and a weekly cadence, reaching 1000 open dedup tasks would
// require ~50 weeks with zero task resolution — well outside normal operation.
// listTasks has no offset support, so true pagination isn't possible without a
// schema change; document this as an accepted ceiling. If it ever becomes an
// issue, adding offset to ListTasksFilters and paginating here is the right fix.
const EXISTING_TASK_FETCH_LIMIT = 1000;

export class ContactFindDuplicatesHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { min_score: rawMinScore, max_tasks: rawMaxTasks } = ctx.input as {
      min_score?: unknown;
      max_tasks?: unknown;
    };

    const minScore = rawMinScore !== undefined ? Number(rawMinScore) : DEFAULT_MIN_SCORE;
    const maxTasks = rawMaxTasks !== undefined ? Number(rawMaxTasks) : undefined;

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
    if (!ctx.entityMemory) {
      return {
        success: false,
        error: 'contact-find-duplicates: entityMemory not available — declare "entityMemory" in capabilities.',
      };
    }

    // Capture as local variables so closures below don't need non-null assertions.
    const taskRepo = ctx.taskRepo;
    const entityMemory = ctx.entityMemory;

    ctx.log.info({ minScore, maxTasks }, 'contact-find-duplicates: starting scan');

    // -- Setup phase: failures here abort the scan entirely before any writes --
    let pairs: DuplicatePair[];
    let existingPairKeys: Set<string>;
    try {
      // Fetch all pairs at the base floor (0.7) then filter to the requested threshold.
      // This avoids changing the ContactService/DedupService interface for a per-call
      // numeric threshold, while keeping the hot path (DB + identity load) a single pass.
      const allPairs = await ctx.contactService.findDuplicates('probable');
      pairs = allPairs.filter((p: DuplicatePair) => p.score >= minScore);

      ctx.log.info(
        { basePairs: allPairs.length, qualifyingPairs: pairs.length, minScore },
        'contact-find-duplicates: threshold filtering complete',
      );

      // Load all open dedup tasks for the idempotency check. The limit is high
      // enough to capture any realistic backlog; pairs already in the queue are
      // silently skipped so repeated runs don't accumulate duplicate tasks.
      const existingTasks = await taskRepo.listTasks({
        statuses: OPEN_STATUSES,
        tag: 'dedup',
        limit: EXISTING_TASK_FETCH_LIMIT,
      });
      if (existingTasks.length >= EXISTING_TASK_FETCH_LIMIT) {
        ctx.log.warn(
          { count: existingTasks.length, limit: EXISTING_TASK_FETCH_LIMIT },
          'contact-find-duplicates: open-task fetch hit limit — idempotency guard may miss older pairs',
        );
      }

      existingPairKeys = new Set<string>();
      let unparseable = 0;
      for (const task of existingTasks) {
        const key = pairKeyFromDedupTask(task);
        if (key) {
          existingPairKeys.add(key);
        } else {
          unparseable++;
        }
      }
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
      ctx.log.error({ err }, 'contact-find-duplicates: setup phase failed (findDuplicates or listTasks)');
      return { success: false, error: `Failed to scan for duplicates: ${message}` };
    }

    // Memoize KG fact lookups for the duration of the run — a contact that appears
    // in multiple pairs would otherwise re-fetch its facts each time. Exclusion
    // facts are permanent and not written by this skill, so caching is safe.
    const factsCache = new Map<string, KgNode[]>();
    const cachedGetFacts = async (nodeId: string): Promise<KgNode[]> => {
      const cached = factsCache.get(nodeId);
      if (cached !== undefined) return cached;
      const facts = await entityMemory.getFacts(nodeId);
      factsCache.set(nodeId, facts);
      return facts;
    };

    let filed = 0;
    let skippedExisting = 0;
    let skippedExcluded = 0;
    let capped = 0;
    let failed = 0;

    // -- Per-pair processing: errors are isolated so one failing pair doesn't abort the scan --
    for (const pair of pairs) {
      const key = canonicalPairKey(pair.contactA.id, pair.contactB.id);

      if (existingPairKeys.has(key)) {
        skippedExisting++;
        continue;
      }

      // Exclusion check is isolated from task filing: a transient getFacts failure
      // should increment failed and skip the pair (same as a task-filing failure),
      // but logging a distinct message lets operators tell the two apart.
      let excluded: boolean;
      try {
        excluded = await hasExclusion({
          contactAId: pair.contactA.id,
          contactBId: pair.contactB.id,
          kgNodeIdA: pair.contactA.kgNodeId,
          kgNodeIdB: pair.contactB.kgNodeId,
          getFacts: cachedGetFacts,
        });
      } catch (exclusionErr) {
        failed++;
        ctx.log.error(
          { exclusionErr, contactAId: pair.contactA.id, contactBId: pair.contactB.id },
          'contact-find-duplicates: exclusion check failed — skipping pair, may re-surface next sweep',
        );
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

      try {
        const description = [
          `Possible duplicate contacts detected by the dedup skill scan.`,
          ``,
          `Contact A ID: ${pair.contactA.id}  (${pair.contactA.displayName})`,
          `Contact B ID: ${pair.contactB.id}  (${pair.contactB.displayName})`,
          ``,
          `Match type: fuzzy`,
          `Reason: ${pair.reason}`,
          `Score: ${pair.score.toFixed(3)}`,
          ``,
          `Please verify these are the same person, then either merge them or mark them as not duplicates (which will prevent future re-surfacing).`,
        ].join('\n');

        await taskRepo.createTask({
          agentId: 'contacts',
          title: `Review possible duplicate: ${pair.contactA.displayName} / ${pair.contactB.displayName}`,
          description,
          owner: 'curia',
          source: 'agent',
          sourceAgentId: 'contacts',
          tags: ['dedup', 'contacts', dedupPairTag(pair.contactA.id, pair.contactB.id)],
          // Copy the cron run's lineage (system) onto the review task (#1125). As a source='agent'
          // task it is a DERIVED child, so when the heartbeat wakes it the bypass ladder requires
          // posture D (score >= 90) to retain system standing — below that it is propose-only and
          // surfaces an approval request instead of auto-executing.
          originator: (ctx.taskMetadata?.originator as TaskOriginator | undefined) ?? null,
        });

        ctx.log.debug(
          { contactAId: pair.contactA.id, contactBId: pair.contactB.id, score: pair.score },
          'contact-find-duplicates: filed review task',
        );
        filed++;
        existingPairKeys.add(key);
      } catch (taskErr) {
        // Fail open: log and continue so one pair error doesn't abort the entire scan.
        // The pair is not counted as filed, so the idempotency check will attempt it again
        // on the next weekly run — the risk of re-filing is preferable to losing all progress.
        failed++;
        ctx.log.error(
          { taskErr, contactAId: pair.contactA.id, contactBId: pair.contactB.id },
          'contact-find-duplicates: error filing task for pair — skipping and continuing',
        );
      }
    }

    ctx.log.info(
      { filed, skippedExisting, skippedExcluded, capped, failed, totalScanned: pairs.length },
      'contact-find-duplicates: scan complete',
    );

    return {
      success: true,
      data: {
        filed,
        skipped_existing: skippedExisting,
        skipped_excluded: skippedExcluded,
        capped,
        failed,
        total_scanned: pairs.length,
      },
    };
  }
}
