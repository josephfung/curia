// voice-learn — weekly WritingVoice refinement from (draft, sent) diffs (#1423).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import {
  DEFAULT_PROVENANCE,
  decideApplication,
  formatProposalBlock,
  isNearDefaultProfile,
  parsePendingDiffs,
  proposeDeltasFromPairs,
  type VoiceProvenanceMap,
} from '../_shared/voice-learn-logic.js';
import {
  PENDING_DIFFS_PATH,
  PENDING_DIFFS_TYPE,
} from '../ceo-inbox-sent-observe/handler.js';
import { VOICE_LEARNING_SCRATCH_PREFIX } from '../_shared/voice-learning-capture.js';

export const PROVENANCE_KEY = 'voice_learn.provenance';
export const DISMISSED_KEY = 'voice_learn.dismissed';
export const BOOTSTRAP_SENT_KEY = 'voice_learn.bootstrap_sent';
export const PENDING_PROPOSALS_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/pending-proposals.md`;
export const PENDING_PROPOSALS_TYPE = 'voice-pending-proposals';
export const CONFIG_NAMESPACE = 'ceo_inbox';

function parseProvenance(raw: string | null): VoiceProvenanceMap {
  if (!raw) return { ...DEFAULT_PROVENANCE };
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceProvenanceMap>;
    return { ...DEFAULT_PROVENANCE, ...parsed };
  } catch {
    return { ...DEFAULT_PROVENANCE };
  }
}

function parseDismissed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as Array<{ dimension: string; until?: string }>;
    const now = Date.now();
    const active = new Set<string>();
    for (const row of parsed) {
      if (!row.dimension) continue;
      if (row.until && Date.parse(row.until) < now) continue;
      active.add(row.dimension);
    }
    return active;
  } catch {
    return new Set();
  }
}

/**
 * Fields that already have an open proposal in the pending-proposals doc and so
 * must not be re-proposed. Because voice-learn re-reads the whole (never-consumed)
 * diff doc every run, a field that stays above threshold would otherwise get a
 * fresh `## Proposal — <field>` block appended each week — duplicates the digest
 * shows and that the non-global status-marker can't all clear. `pending` = still
 * awaiting the CEO; `approved` = already applied, don't nag again. `dismissed` is
 * intentionally NOT blocked here — its cooldown is enforced via dismissedDimensions.
 */
function blockedProposalFields(body: string): Set<string> {
  const blocked = new Set<string>();
  for (const section of body.split(/^## Proposal — /m).slice(1)) {
    const field = (section.split('\n')[0] ?? '').trim();
    if (!field) continue;
    const status = (section.match(/- status:\s*(\S+)/)?.[1] ?? 'pending').trim();
    if (status === 'pending' || status === 'approved') blocked.add(field);
  }
  return blocked;
}

export class VoiceLearnHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.executiveProfileService || !ctx.workingDocs || !ctx.entityMemory) {
      return {
        success: false,
        error: 'voice-learn requires executiveProfileService, workingDocs, and entityMemory',
      };
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const dryRun = input.dry_run === true;

    const diffsDoc = await ctx.workingDocs.read(PENDING_DIFFS_PATH);
    const pairs = parsePendingDiffs(diffsDoc?.body ?? '');
    if (pairs.length === 0) {
      ctx.log.info({}, 'voice-learn: no qualifying pairs — nothing to learn');
      return {
        success: true,
        data: {
          pairs_considered: 0,
          auto_applied: 0,
          proposed: 0,
          skipped: 0,
          bootstrap: false,
        },
      };
    }

    const store = new ConfigStore(ctx.entityMemory, ctx.log);
    const provenance = parseProvenance(await store.get(CONFIG_NAMESPACE, PROVENANCE_KEY));
    const dismissed = parseDismissed(await store.get(CONFIG_NAMESPACE, DISMISSED_KEY));

    const profile = ctx.executiveProfileService.get();
    const voice = profile.writingVoice;
    const bootstrap = isNearDefaultProfile(voice);

    // Read the existing proposals once so we can dedup: the diff doc is never
    // consumed, so without this a still-above-threshold field re-proposes weekly.
    const existingProposalsDoc = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
    const blockedFields = blockedProposalFields(existingProposalsDoc?.body ?? '');

    const deltas = proposeDeltasFromPairs(pairs);
    let autoApplied = 0;
    let proposed = 0;
    let skipped = 0;
    const proposalChunks: string[] = [];
    const provenanceUpdates: Partial<VoiceProvenanceMap> = {};

    for (const delta of deltas) {
      const decision = decideApplication(delta, provenance, {
        currentSignOffEmpty: voice.signOff.trim() === '',
        currentVocabularyEmpty:
          voice.vocabulary.prefer.length === 0 && voice.vocabulary.avoid.length === 0,
        dismissedDimensions: dismissed,
      });

      if (decision.action === 'skip') {
        skipped += 1;
        continue;
      }

      if (decision.action === 'propose' || decision.delta.magnitude === 'high') {
        // Don't re-append a proposal for a field that already has one open.
        if (blockedFields.has(delta.field)) {
          skipped += 1;
          continue;
        }
        blockedFields.add(delta.field);
        proposed += 1;
        proposalChunks.push(formatProposalBlock({ ...decision, action: 'propose' }));
        continue;
      }

      // auto
      if (dryRun) {
        autoApplied += 1;
        continue;
      }

      try {
        const current = ctx.executiveProfileService.get().writingVoice;
        const patch = decision.delta.patch;
        const merged = {
          writingVoice: {
            ...current,
            ...(typeof patch.sign_off === 'string' ? { signOff: patch.sign_off } : {}),
            ...(patch.vocabulary && typeof patch.vocabulary === 'object'
              ? {
                  vocabulary: {
                    prefer: [
                      ...new Set([
                        ...current.vocabulary.prefer,
                        ...((patch.vocabulary as { prefer?: string[] }).prefer ?? []),
                      ]),
                    ],
                    avoid: [
                      ...new Set([
                        ...current.vocabulary.avoid,
                        ...((patch.vocabulary as { avoid?: string[] }).avoid ?? []),
                      ]),
                    ],
                  },
                }
              : {}),
          },
        };
        await ctx.executiveProfileService.update(
          merged,
          'skill',
          `voice-learn auto: ${decision.delta.description}`,
        );
        provenanceUpdates[decision.delta.field] = 'learned';
        autoApplied += 1;
      } catch (err) {
        ctx.log.error({ err, field: decision.delta.field }, 'voice-learn: auto-apply failed');
        // Fall back to a proposal, but still dedup against any open one.
        if (!blockedFields.has(decision.delta.field)) {
          blockedFields.add(decision.delta.field);
          proposed += 1;
          proposalChunks.push(formatProposalBlock({ ...decision, action: 'propose' }));
        } else {
          skipped += 1;
        }
      }
    }

    if (!dryRun && Object.keys(provenanceUpdates).length > 0) {
      await store.set(
        CONFIG_NAMESPACE,
        PROVENANCE_KEY,
        JSON.stringify({ ...provenance, ...provenanceUpdates }),
      );
    }

    if (!dryRun && proposalChunks.length > 0) {
      // Reuse the doc read at the top of the run (single-threaded weekly job).
      const existing = existingProposalsDoc;
      if (!existing) {
        await ctx.workingDocs.create({
          path: PENDING_PROPOSALS_PATH,
          type: PENDING_PROPOSALS_TYPE,
          frontmatter: { title: 'Pending voice proposals' },
          body: `# Pending voice proposals\n\n${proposalChunks.join('')}`,
          agentId: ctx.agentId,
        });
      } else {
        await ctx.workingDocs.append(PENDING_PROPOSALS_PATH, {
          content: proposalChunks.join(''),
          expectedVersion: existing.version,
        });
      }
    }

    // One-time bootstrap marker (onboarding summary is surfaced via digest / agent prompt).
    let bootstrapFlag = false;
    if (bootstrap && pairs.length > 0) {
      const already = await store.get(CONFIG_NAMESPACE, BOOTSTRAP_SENT_KEY);
      if (!already) {
        bootstrapFlag = true;
        if (!dryRun) {
          await store.set(CONFIG_NAMESPACE, BOOTSTRAP_SENT_KEY, new Date().toISOString());
        }
      }
    }

    // Optionally note that diffs were consumed — leave evidence for now; retention
    // sweep can prune later. Touch the diffs doc type for liveness.
    void PENDING_DIFFS_TYPE;

    ctx.log.info(
      { pairs: pairs.length, autoApplied, proposed, skipped, bootstrap: bootstrapFlag },
      'voice-learn: run complete',
    );

    return {
      success: true,
      data: {
        pairs_considered: pairs.length,
        auto_applied: autoApplied,
        proposed,
        skipped,
        bootstrap: bootstrapFlag,
      },
    };
  }
}
