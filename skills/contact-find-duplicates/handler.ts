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

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { DuplicatePair } from '../../src/contacts/types.js';
import type { KgNode } from '../../src/memory/types.js';

// Default minimum Jaro-Winkler score — chosen empirically as the precision sweet
// spot on the production contact set (0.95 is very clean, 0.90 starts to pick up
// same-surname false positives, 0.7 is the DedupService base floor). See #1037.
const DEFAULT_MIN_SCORE = 0.93;

// Statuses that constitute an "open" task for idempotency purposes.
const OPEN_STATUSES = ['open', 'in_progress', 'waiting', 'blocked'];

// Upper bound on how many open dedup tasks we load for the idempotency check.
// With a per-run max_tasks cap, the realistic ceiling is much lower — but 1000
// ensures we never silently miss existing tasks and re-file them.
const EXISTING_TASK_FETCH_LIMIT = 1000;

// Regex to extract contact IDs from task descriptions filed by this skill or
// by the dedup-contacts maintenance script, both of which use the same format:
//   "Contact A ID: <uuid>  (Display Name)"
//   "Contact B ID: <uuid>  (Display Name)"
const CONTACT_ID_LINE_RE = /Contact ([AB]) ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Canonical (order-independent) key for a contact pair. */
function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

/** Extract contact A and B IDs from a dedup task description. Returns null if not found. */
function extractPairIds(description: string | null | undefined): { aId: string; bId: string } | null {
  if (!description) return null;
  const found: Record<string, string> = {};
  for (const match of description.matchAll(CONTACT_ID_LINE_RE)) {
    found[match[1]!.toUpperCase()] = match[2]!;
  }
  if (found['A'] && found['B']) return { aId: found['A'], bId: found['B'] };
  return null;
}

/**
 * Check whether either contact in a pair has a dedup_exclusion KG fact naming
 * the other — bidirectional, same logic as hasExclusion() in dedup-contacts.ts.
 * Short-circuits to false when neither contact has a kgNodeId.
 *
 * Matching is by `properties.attribute === 'dedup_exclusion'` only (per the KG
 * fact schema guidance: never match on `label` for lookups). This assumes that
 * no other part of the system stores facts with this attribute name for an
 * unrelated purpose, which is enforced by convention — the attribute is
 * exclusively written by writeExclusion() in dedup-contacts.ts.
 */
async function checkExclusion(
  aId: string,
  bId: string,
  kgNodeIdA: string | null,
  kgNodeIdB: string | null,
  getFacts: (nodeId: string) => Promise<KgNode[]>,
): Promise<boolean> {
  if (kgNodeIdA === null && kgNodeIdB === null) return false;

  if (kgNodeIdA !== null) {
    const factsA = await getFacts(kgNodeIdA);
    for (const fact of factsA) {
      const props = fact.properties as Record<string, unknown>;
      if (props['attribute'] === 'dedup_exclusion' && props['value'] === bId) return true;
    }
  }

  if (kgNodeIdB !== null) {
    const factsB = await getFacts(kgNodeIdB);
    for (const fact of factsB) {
      const props = fact.properties as Record<string, unknown>;
      if (props['attribute'] === 'dedup_exclusion' && props['value'] === aId) return true;
    }
  }

  return false;
}

export class ContactFindDuplicatesHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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

    ctx.log.info({ minScore, maxTasks }, 'contact-find-duplicates: starting scan');

    try {
      // Fetch all pairs at the base floor (0.7) then filter to the requested threshold.
      // This avoids changing the ContactService/DedupService interface for a per-call
      // numeric threshold, while keeping the hot path (DB + identity load) a single pass.
      const allPairs = await ctx.contactService.findDuplicates('probable');
      const pairs = allPairs.filter((p: DuplicatePair) => p.score >= minScore);

      ctx.log.info(
        { basePairs: allPairs.length, qualifyingPairs: pairs.length, minScore },
        'contact-find-duplicates: threshold filtering complete',
      );

      // Load all open dedup tasks for the idempotency check. The limit is high
      // enough to capture any realistic backlog; pairs already in the queue are
      // silently skipped so repeated runs don't accumulate duplicate tasks.
      const existingTasks = await ctx.taskRepo.listTasks({
        statuses: OPEN_STATUSES,
        tag: 'dedup',
        limit: EXISTING_TASK_FETCH_LIMIT,
      });
      const existingPairKeys = new Set<string>();
      for (const task of existingTasks) {
        const ids = extractPairIds(task.description ?? null);
        if (ids) {
          existingPairKeys.add(pairKey(ids.aId, ids.bId));
        } else {
          // A dedup-tagged task whose description doesn't contain the expected
          // "Contact A/B ID: <uuid>" lines is invisible to the idempotency check —
          // the pair will be re-filed if it comes up again. Log so operators can
          // investigate (e.g. manually-created tasks, old format, truncated description).
          ctx.log.warn({ taskId: task.id }, 'contact-find-duplicates: dedup task has no parseable contact IDs — excluded from idempotency check');
        }
      }

      // Memoize KG fact lookups for the duration of the run — a contact that appears
      // in multiple pairs would otherwise re-fetch its facts each time. Exclusion
      // facts are permanent and not written by this skill, so caching is safe.
      const factsCache = new Map<string, KgNode[]>();
      const cachedGetFacts = async (nodeId: string): Promise<KgNode[]> => {
        const cached = factsCache.get(nodeId);
        if (cached !== undefined) return cached;
        const facts = await ctx.entityMemory!.getFacts(nodeId);
        factsCache.set(nodeId, facts);
        return facts;
      };

      let filed = 0;
      let skippedExisting = 0;
      let skippedExcluded = 0;
      let capped = 0;

      for (const pair of pairs) {
        const key = pairKey(pair.contactA.id, pair.contactB.id);

        if (existingPairKeys.has(key)) {
          skippedExisting++;
          continue;
        }

        const excluded = await checkExclusion(
          pair.contactA.id,
          pair.contactB.id,
          pair.contactA.kgNodeId,
          pair.contactB.kgNodeId,
          cachedGetFacts,
        );
        if (excluded) {
          skippedExcluded++;
          continue;
        }

        if (maxTasks !== undefined && filed >= maxTasks) {
          capped++;
          continue;
        }

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

        await ctx.taskRepo.createTask({
          agentId: 'contacts',
          title: `Review possible duplicate: ${pair.contactA.displayName} / ${pair.contactB.displayName}`,
          description,
          owner: 'curia',
          source: 'agent',
          sourceAgentId: 'contacts',
          tags: ['dedup', 'contacts'],
        });

        ctx.log.debug(
          { contactAId: pair.contactA.id, contactBId: pair.contactB.id, score: pair.score },
          'contact-find-duplicates: filed review task',
        );
        filed++;
      }

      ctx.log.info(
        { filed, skippedExisting, skippedExcluded, capped, totalScanned: pairs.length },
        'contact-find-duplicates: scan complete',
      );

      return {
        success: true,
        data: {
          filed,
          skipped_existing: skippedExisting,
          skipped_excluded: skippedExcluded,
          capped,
          total_scanned: pairs.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'contact-find-duplicates failed');
      return { success: false, error: `Failed to scan for duplicates: ${message}` };
    }
  }
}
