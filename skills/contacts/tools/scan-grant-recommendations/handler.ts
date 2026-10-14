// handler.ts — scan-grant-recommendations skill.
//
// Implements the LLM-judge-driven recommendation engine from issue #952.
// For each high-confidence known-tier contact without a scheduling grant,
// the judge decides (yes/no/reasoning) whether to surface a recommendation.
//
// Anti-nag: a row in grant_recommendations for (contact_id, permission) — at
// any status — permanently blocks re-suggestion for that pair.
//
// Cadence ceiling: the run stops creating new recommendations once
// cadence_ceiling new ones have been produced, preventing a burst.
//
// Delivery (#2129): each pending recommendation is filed as a task the principal
// owns. The backlog line counts open `owner = 'ceo'` tasks on every principal turn,
// so the coordinator raises it at a natural pause, and routes the answer back to
// contacts with the task id. The scan's own reply reaches no one (a scheduled
// turn has no routing entry), so the task is the only delivery path. A pending
// recommendation with no task yet (a failed filing, or one created before #2129)
// is filed on the next run; one whose task was closed is never re-filed.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { TaskOriginator } from '../../../../src/contacts/types.js';

const CANDIDATE_PERMISSION = 'schedule_meetings';

/** Tag on every grant-recommendation task, and the prefix of the per-recommendation tag. */
export const GRANT_REC_TASK_TAG = 'grant-recommendation';
const GRANT_REC_ID_TAG_PREFIX = 'grant-rec:';

// Upper bound on the grant-recommendation tasks loaded to find which pending
// recommendations already have one. The cadence ceiling caps new ones at 10 a
// week, so this is years of history; past it a recommendation may be re-filed.
const EXISTING_TASK_FETCH_LIMIT = 1000;

/** The per-recommendation tag, so a task can be matched to its recommendation. */
export function grantRecTag(recommendationId: string): string {
  return `${GRANT_REC_ID_TAG_PREFIX}${recommendationId.toLowerCase()}`;
}

const JUDGE_SYSTEM_PROMPT = `You are a trust assessment judge for an AI executive assistant. Decide whether a contact has demonstrated sufficient collaborative behavior to be formally granted scheduling access on the executive's behalf.

Respond only in this exact JSON format:
{"recommend": true | false, "reasoning": "One sentence explaining your recommendation."}

Recommend only when the evidence clearly shows the contact regularly and productively coordinates the executive's schedule (frequent confirmed meetings, calendar coordination). Default to false when evidence is weak or ambiguous. The reasoning field is shown to the executive.`;

function buildJudgePrompt(
  displayName: string,
  organization: string | null,
  role: string | null,
  confidence: number,
  inbound: number,
  outbound: number,
): string {
  const context = [
    `Contact: ${displayName}`,
    role ? `Role: ${role}` : null,
    organization ? `Organization: ${organization}` : null,
    `Confidence score: ${confidence.toFixed(2)} (0–1; ≥0.65 means meaningful interaction history)`,
    `Messages received from them: ${inbound}`,
    `Messages sent to them: ${outbound}`,
  ].filter(Boolean).join('\n');
  return `${context}\n\nShould this contact be granted scheduling access (schedule_meetings) on the executive's behalf?`;
}

export class ScanGrantRecommendationsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.infraLlm) {
      return { success: false, error: 'scan-grant-recommendations: infraLlm capability missing' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'scan-grant-recommendations: contactService not available' };
    }
    if (!ctx.taskRepo) {
      return { success: false, error: 'scan-grant-recommendations: taskRepo not available — declare "taskRepo" in capabilities.' };
    }

    const svc = ctx.contactService;
    const taskRepo = ctx.taskRepo;

    const input = ctx.input as {
      confidence_threshold?: number;
      max_candidates?: number;
      cadence_ceiling?: number;
    };

    const confidenceThreshold = typeof input.confidence_threshold === 'number'
      ? Math.max(0, Math.min(1, input.confidence_threshold))
      : 0.65;
    const maxCandidates = typeof input.max_candidates === 'number'
      ? Math.min(Math.max(1, input.max_candidates), 50)
      : 20;
    const cadenceCeiling = typeof input.cadence_ceiling === 'number'
      ? Math.min(Math.max(1, input.cadence_ceiling), 10)
      : 3;

    // Load known-tier contacts and pre-fetch all existing recommendations
    let candidates: Awaited<ReturnType<typeof svc.listContacts>>;
    let allRecs: Awaited<ReturnType<typeof svc.listGrantRecommendations>>;
    try {
      candidates = await svc.listContacts({ tier: 'known', limit: maxCandidates });
      allRecs = await svc.listGrantRecommendations({ limit: 10000 });
    } catch (err) {
      ctx.log.error({ err }, 'scan-grant-recommendations: failed to load candidates or existing recommendations');
      return { success: false, error: 'Failed to load contacts or existing recommendations.' };
    }

    const existingPairs = new Set(allRecs.map(r => `${r.contactId}:${r.permission}`));

    let evaluated = 0;
    let created = 0;
    let skippedExisting = 0;
    let skippedJudge = 0;
    let skippedErrors = 0;
    const recommendationsCreated: Array<{ id: string; contact_id: string; contact_name: string; permission: string; reasoning: string }> = [];

    for (const contact of candidates) {
      if (created >= cadenceCeiling) break;
      // Skip automated senders and agents — they are exempt from tier gates
      if (contact.kind === 'automated' || contact.kind === 'agent') continue;
      if (contact.contactConfidence < confidenceThreshold) continue;

      evaluated++;

      // Skip if a recommendation for this pair already exists (any status)
      if (existingPairs.has(`${contact.id}:${CANDIDATE_PERMISSION}`)) {
        skippedExisting++;
        continue;
      }

      // Skip if the permission is already explicitly granted or denied via an override
      let overrides: Awaited<ReturnType<typeof svc.getAuthOverrides>>;
      try {
        overrides = await svc.getAuthOverrides(contact.id);
      } catch (err) {
        ctx.log.warn({ err, contactId: contact.id }, 'scan-grant-recommendations: override lookup failed, skipping contact');
        skippedErrors++;
        continue;
      }
      if (overrides.some(o => o.permission === CANDIDATE_PERMISSION)) {
        skippedExisting++;
        continue;
      }

      // Ask the LLM judge
      let judgeResult: Awaited<ReturnType<typeof ctx.infraLlm.extract>>;
      try {
        judgeResult = await ctx.infraLlm.extract(
          `${JUDGE_SYSTEM_PROMPT}\n\n${buildJudgePrompt(
            contact.displayName,
            contact.organization ?? null,
            contact.role ?? null,
            contact.contactConfidence,
            contact.inboundMessageCount,
            contact.outboundMessageCount,
          )}`,
        );
      } catch (err) {
        ctx.log.warn({ err, contactId: contact.id }, 'scan-grant-recommendations: judge transport error, skipping contact');
        skippedErrors++;
        continue;
      }

      if (!judgeResult.ok) {
        ctx.log.warn({ contactId: contact.id, error: judgeResult.error }, 'scan-grant-recommendations: judge call failed');
        skippedErrors++;
        continue;
      }

      let verdict: { recommend: boolean; reasoning: string } | null = null;
      try {
        const parsed = JSON.parse(judgeResult.text) as { recommend?: unknown; reasoning?: unknown };
        if (typeof parsed.recommend === 'boolean' && typeof parsed.reasoning === 'string') {
          verdict = { recommend: parsed.recommend, reasoning: parsed.reasoning };
        }
      } catch {
        ctx.log.warn({ contactId: contact.id, raw: judgeResult.text.slice(0, 200) }, 'scan-grant-recommendations: unparseable judge response');
        skippedErrors++;
        continue;
      }

      if (!verdict?.recommend) {
        ctx.log.debug({ contactId: contact.id, reasoning: verdict?.reasoning }, 'scan-grant-recommendations: judge declined');
        skippedJudge++;
        continue;
      }

      let createdResult: Awaited<ReturnType<typeof svc.createGrantRecommendation>>;
      try {
        createdResult = await svc.createGrantRecommendation(
          contact.id,
          CANDIDATE_PERMISSION,
          verdict.reasoning,
        );
      } catch (err) {
        // createGrantRecommendation throws when ON CONFLICT skipped the insert
        // but the winner vanished before re-fetch (e.g. ON DELETE CASCADE). Treat
        // that like the other per-contact failures so earlier creates in this run
        // still report (issue #1067).
        ctx.log.warn({ err, contactId: contact.id }, 'scan-grant-recommendations: create failed, skipping contact');
        skippedErrors++;
        continue;
      }
      const { created: wasCreated, recommendation } = createdResult;

      if (wasCreated) {
        ctx.log.info({ contactId: contact.id, permission: CANDIDATE_PERMISSION }, 'scan-grant-recommendations: recommendation created');
        existingPairs.add(`${contact.id}:${CANDIDATE_PERMISSION}`);
        recommendationsCreated.push({
          id: recommendation.id,
          contact_id: contact.id,
          contact_name: contact.displayName,
          permission: CANDIDATE_PERMISSION,
          reasoning: verdict.reasoning,
        });
        created++;
      } else {
        skippedExisting++;
      }
    }

    // -- Delivery: file a principal-owned task for every pending recommendation without one --
    let tasksFiled = 0;
    let taskFailures = 0;
    let taggedRecIds: Set<string>;
    try {
      // Every status, not just open: a closed task means the principal answered or
      // deferred, and a deferral must not resurface the recommendation weekly.
      const existingTasks = await taskRepo.listTasks({ tag: GRANT_REC_TASK_TAG, limit: EXISTING_TASK_FETCH_LIMIT });
      if (existingTasks.length >= EXISTING_TASK_FETCH_LIMIT) {
        ctx.log.warn(
          { count: existingTasks.length, limit: EXISTING_TASK_FETCH_LIMIT },
          'scan-grant-recommendations: task fetch hit limit — an older recommendation may be re-filed',
        );
      }
      taggedRecIds = new Set(
        existingTasks.flatMap(t => t.tags.filter(tag => tag.startsWith(GRANT_REC_ID_TAG_PREFIX))),
      );
    } catch (err) {
      // The recommendations are already written; without the task list we cannot tell
      // which are already filed, so file none rather than duplicate. The next run retries.
      ctx.log.error({ err }, 'scan-grant-recommendations: failed to load existing recommendation tasks');
      return {
        success: false,
        error: `Created ${created} recommendation(s) but could not load existing recommendation tasks, so none were filed for the principal. The next run will file them.`,
      };
    }

    const createdById = new Map(recommendationsCreated.map(r => [r.id, r]));
    const pending = [
      ...allRecs
        .filter(r => r.status === 'pending' && r.permission === CANDIDATE_PERMISSION)
        .map(r => ({ id: r.id, contactId: r.contactId, reasoning: r.reasoning })),
      ...recommendationsCreated.map(r => ({ id: r.id, contactId: r.contact_id, reasoning: r.reasoning })),
    ];
    const originator = (ctx.taskMetadata?.originator as TaskOriginator | undefined) ?? null;

    for (const rec of pending) {
      const tag = grantRecTag(rec.id);
      if (taggedRecIds.has(tag)) continue;
      try {
        const contactName = createdById.get(rec.id)?.contact_name
          ?? (await svc.getContact(rec.contactId))?.displayName;
        if (!contactName) {
          // The contact was deleted (its recommendation cascades with it), so there is
          // nothing to ask about.
          ctx.log.warn({ recommendationId: rec.id, contactId: rec.contactId }, 'scan-grant-recommendations: contact gone, recommendation not filed');
          continue;
        }
        await taskRepo.createTask({
          agentId: 'contacts',
          title: `Grant ${contactName} scheduling access?`,
          description: [
            `Grant recommendation from the weekly scan: give ${contactName} formal scheduling access (${CANDIDATE_PERMISSION}).`,
            ``,
            `Recommendation ID: ${rec.id}`,
            `Contact ID: ${rec.contactId}  (${contactName})`,
            `Why: ${rec.reasoning}`,
            ``,
            `Ask the principal to approve or decline. Pass their answer to the contacts specialist with this task's ID.`,
          ].join('\n'),
          owner: 'ceo',
          source: 'agent',
          sourceAgentId: 'contacts',
          tags: [GRANT_REC_TASK_TAG, 'contacts', tag],
          progressNote: `Should ${contactName} get formal scheduling access? ${rec.reasoning} Waiting on the principal to approve or decline; their answer goes to the contacts specialist with this task's ID.`,
          // Same lineage as the dedup review tasks (#1125): the cron run's originator.
          originator,
        });
        taggedRecIds.add(tag);
        tasksFiled++;
      } catch (err) {
        // Fail open per recommendation: it stays pending without a task, so the next run files it.
        taskFailures++;
        ctx.log.error({ err, recommendationId: rec.id }, 'scan-grant-recommendations: failed to file principal task');
      }
    }

    return {
      success: true,
      data: {
        evaluated,
        created,
        skipped_existing: skippedExisting,
        skipped_judge: skippedJudge,
        skipped_errors: skippedErrors,
        recommendations_created: recommendationsCreated,
        tasks_filed: tasksFiled,
        task_failures: taskFailures,
      },
    };
  }
}
