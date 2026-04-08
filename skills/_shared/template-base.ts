// template-base.ts — shared logic for all email policy template skills.
//
// Each template skill (meeting-request, reschedule, cancel, doc-request)
// follows the same pattern: store/retrieve email composing guidelines from
// the knowledge graph, with support for natural-language refinements.
//
// This module provides the common implementation. Individual skill handlers
// extend it with their specific default policy and input validation.
//
// KG storage model (per template type):
//   - Anchor node: type=concept, label=TEMPLATE_LABEL
//   - Base policy: fact node with label="email policy"
//   - Refinements: fact nodes with label="policy refinement: <timestamp>"
//   - Clear marker: fact node with label="refinements cleared"
//   - All decayClass=permanent

import type { SkillContext, SkillResult, AgentPersona } from '../../src/skills/types.js';

/** Build the email signature from the agent persona, or a safe fallback. */
export function resolveSignature(persona?: AgentPersona): string {
  if (persona?.emailSignature) return persona.emailSignature;
  if (persona) return `${persona.displayName}, ${persona.title}`;
  return '';
}

/**
 * Save a complete custom policy, replacing the existing one.
 */
export async function savePolicy(
  ctx: SkillContext,
  templateLabel: string,
  skillSource: string,
): Promise<SkillResult> {
  const { custom_policy } = ctx.input as { custom_policy?: string };
  if (!custom_policy || typeof custom_policy !== 'string') {
    return { success: false, error: 'Missing required input: custom_policy (a JSON string describing the email policy, or plain-text guidelines)' };
  }
  if (custom_policy.length > 10000) {
    return { success: false, error: 'custom_policy must be 10000 characters or fewer' };
  }
  if (!ctx.entityMemory) {
    return { success: false, error: 'Knowledge graph not available — cannot save custom policy' };
  }

  try {
    const anchorId = await findOrCreateAnchor(ctx, templateLabel, skillSource);
    await ctx.entityMemory.storeFact({
      entityNodeId: anchorId,
      label: 'email policy',
      properties: { policy: custom_policy },
      confidence: 1.0,
      decayClass: 'permanent',
      source: skillSource,
    });
    ctx.log.info('Saved custom email policy to knowledge graph');
    return { success: true, data: { saved: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err }, 'Failed to save custom policy');
    return { success: false, error: `Failed to save policy: ${message}` };
  }
}

/**
 * Accept a natural-language refinement and store it as an additive adjustment.
 * Refinements accumulate — each one is preserved independently so the
 * compose-time LLM can see the full history of adjustments.
 *
 * Examples: "make these less formal", "always mention my assistant can help"
 */
export async function updatePolicy(
  ctx: SkillContext,
  templateLabel: string,
  skillSource: string,
): Promise<SkillResult> {
  const { refinement } = ctx.input as { refinement?: string };
  if (!refinement || typeof refinement !== 'string') {
    return { success: false, error: 'Missing required input: refinement (a natural-language instruction describing how to adjust the email policy)' };
  }
  if (refinement.length > 2000) {
    return { success: false, error: 'refinement must be 2000 characters or fewer' };
  }
  if (!ctx.entityMemory) {
    return { success: false, error: 'Knowledge graph not available — cannot store policy refinement' };
  }

  try {
    const anchorId = await findOrCreateAnchor(ctx, templateLabel, skillSource);

    // Each refinement gets a unique label so they accumulate rather than
    // overwriting each other via storeFact's dedup logic.
    const timestamp = new Date().toISOString();
    await ctx.entityMemory.storeFact({
      entityNodeId: anchorId,
      label: `policy refinement: ${timestamp}`,
      properties: { refinement, addedAt: timestamp },
      confidence: 1.0,
      decayClass: 'permanent',
      source: skillSource,
    });

    ctx.log.info({ refinement }, 'Stored policy refinement');
    return { success: true, data: { updated: true, refinement } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err }, 'Failed to store policy refinement');
    return { success: false, error: `Failed to store refinement: ${message}` };
  }
}

/**
 * Reset clears both the custom base policy and all accumulated refinements.
 */
export async function resetPolicy(
  ctx: SkillContext,
  templateLabel: string,
  skillSource: string,
): Promise<SkillResult> {
  if (!ctx.entityMemory) {
    return { success: true, data: { reset: true } };
  }

  try {
    const existing = await ctx.entityMemory.findEntities(templateLabel);
    if (existing.length > 0) {
      const facts = await ctx.entityMemory.getFacts(existing[0]!.id);
      if (facts.length > 0) {
        await ctx.entityMemory.storeFact({
          entityNodeId: existing[0]!.id,
          label: 'email policy',
          properties: { policy: '', cleared: true },
          confidence: 1.0,
          decayClass: 'permanent',
          source: skillSource,
        });
        // Mark all existing refinements as cleared — resolvePolicy will
        // ignore refinements with addedAt before this timestamp.
        await ctx.entityMemory.storeFact({
          entityNodeId: existing[0]!.id,
          label: 'refinements cleared',
          properties: { clearedAt: new Date().toISOString() },
          confidence: 1.0,
          decayClass: 'permanent',
          source: skillSource,
        });
      }
    }

    ctx.log.info('Reset email policy and refinements to default');
    return { success: true, data: { reset: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err }, 'Failed to reset policy');
    return { success: false, error: `Failed to reset policy: ${message}` };
  }
}

/**
 * Look up the email policy from the knowledge graph.
 *
 * Returns the base policy (custom or default) plus any accumulated
 * refinements. Refinements added before the last "reset" are ignored.
 */
export async function resolvePolicy(
  ctx: SkillContext,
  templateLabel: string,
  defaultPolicy: unknown,
): Promise<{ policy: unknown; source: 'default' | 'custom' | 'refined' }> {
  if (!ctx.entityMemory) {
    return { policy: defaultPolicy, source: 'default' };
  }

  try {
    const nodes = await ctx.entityMemory.findEntities(templateLabel);
    if (nodes.length === 0) {
      return { policy: defaultPolicy, source: 'default' };
    }

    const facts = await ctx.entityMemory.getFacts(nodes[0]!.id);

    // Resolve the base policy (custom or default)
    let basePolicy: unknown = defaultPolicy;
    let hasCustomBase = false;

    const policyFact = facts
      .filter((f) => f.label === 'email policy')
      .sort((a, b) => b.temporal.lastConfirmedAt.getTime() - a.temporal.lastConfirmedAt.getTime())[0];

    if (policyFact) {
      const rawPolicy = policyFact.properties.policy;
      if (typeof rawPolicy === 'string' && rawPolicy.length > 0 && !policyFact.properties.cleared) {
        hasCustomBase = true;
        try {
          basePolicy = JSON.parse(rawPolicy) as unknown;
        } catch {
          basePolicy = { custom_guidelines: rawPolicy, note: 'Custom guidelines that override the default policy.' };
        }
      }
    }

    // Check if refinements were cleared
    const clearedFact = facts
      .filter((f) => f.label === 'refinements cleared')
      .sort((a, b) => b.temporal.lastConfirmedAt.getTime() - a.temporal.lastConfirmedAt.getTime())[0];
    const clearedAt = clearedFact?.properties.clearedAt
      ? new Date(clearedFact.properties.clearedAt as string).getTime()
      : 0;

    // Gather refinements added after the last clear, oldest-first
    const refinements = facts
      .filter((f) => {
        if (!f.label.startsWith('policy refinement:')) return false;
        const addedAt = f.properties.addedAt
          ? new Date(f.properties.addedAt as string).getTime()
          : f.temporal.createdAt.getTime();
        return addedAt > clearedAt;
      })
      .sort((a, b) => a.temporal.createdAt.getTime() - b.temporal.createdAt.getTime())
      .map((f) => f.properties.refinement as string);

    if (refinements.length > 0) {
      return {
        policy: {
          base_policy: basePolicy,
          refinements,
          note: 'The base_policy defines the structural guidelines. The refinements are user-requested adjustments listed in chronological order — apply them all when composing. If a refinement contradicts the base policy, the refinement takes priority.',
        },
        source: 'refined',
      };
    }

    return {
      policy: basePolicy,
      source: hasCustomBase ? 'custom' : 'default',
    };
  } catch (err) {
    ctx.log.warn({ err }, 'Failed to look up custom policy, using default');
    return { policy: defaultPolicy, source: 'default' };
  }
}

/** Find or create the anchor node for a template type. */
async function findOrCreateAnchor(
  ctx: SkillContext,
  templateLabel: string,
  skillSource: string,
): Promise<string> {
  const existing = await ctx.entityMemory!.findEntities(templateLabel);
  if (existing.length > 0) return existing[0]!.id;

  const { entity: anchor } = await ctx.entityMemory!.createEntity({
    type: 'concept',
    label: templateLabel,
    properties: { category: 'email-policy' },
    source: skillSource,
  });
  return anchor.id;
}
