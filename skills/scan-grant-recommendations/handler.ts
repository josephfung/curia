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

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

const CANDIDATE_PERMISSION = 'schedule_meetings';

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

export class ScanGrantRecommendationsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.infraLlm) {
      return { success: false, error: 'scan-grant-recommendations: infraLlm capability missing' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'scan-grant-recommendations: contactService not available' };
    }

    const svc = ctx.contactService;

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

    // Load known-tier contacts as candidates
    const candidates = await svc.listContacts({ tier: 'known', limit: maxCandidates });

    // Pre-fetch all existing recommendations once to avoid N per-contact DB queries
    const allRecs = await svc.listGrantRecommendations({ limit: 10000 });
    const existingPairs = new Set(allRecs.map(r => `${r.contactId}:${r.permission}`));

    let evaluated = 0;
    let created = 0;
    let skippedExisting = 0;
    let skippedJudge = 0;

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
      const overrides = await svc.getAuthOverrides(contact.id);
      if (overrides.some(o => o.permission === CANDIDATE_PERMISSION)) {
        skippedExisting++;
        continue;
      }

      // Ask the LLM judge
      const judgeResult = await ctx.infraLlm.extract(
        `${JUDGE_SYSTEM_PROMPT}\n\n${buildJudgePrompt(
          contact.displayName,
          contact.organization ?? null,
          contact.role ?? null,
          contact.contactConfidence,
          contact.inboundMessageCount,
          contact.outboundMessageCount,
        )}`,
      );

      if (!judgeResult.ok) {
        ctx.log.warn({ contactId: contact.id, error: judgeResult.error }, 'scan-grant-recommendations: judge call failed');
        skippedJudge++;
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
        skippedJudge++;
        continue;
      }

      if (!verdict?.recommend) {
        ctx.log.debug({ contactId: contact.id, reasoning: verdict?.reasoning }, 'scan-grant-recommendations: judge declined');
        skippedJudge++;
        continue;
      }

      const { created: wasCreated } = await svc.createGrantRecommendation(
        contact.id,
        CANDIDATE_PERMISSION,
        verdict.reasoning,
      );

      if (wasCreated) {
        ctx.log.info({ contactId: contact.id, permission: CANDIDATE_PERMISSION }, 'scan-grant-recommendations: recommendation created');
        existingPairs.add(`${contact.id}:${CANDIDATE_PERMISSION}`);
        created++;
      } else {
        skippedExisting++;
      }
    }

    return {
      success: true,
      data: { evaluated, created, skipped_existing: skippedExisting, skipped_judge: skippedJudge },
    };
  }
}
