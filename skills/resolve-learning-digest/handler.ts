import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import {
  CONFIG_NAMESPACE as VOICE_NS,
  DISMISSED_KEY,
  PENDING_PROPOSALS_PATH,
  PROVENANCE_KEY,
} from '../voice-learn/handler.js';
import { COMPLETION_DIGEST_PATH } from '../task-completion-from-sent/handler.js';
import {
  markCompletionStatus,
  markProposalStatus,
  parseVoiceProposals,
  type VoiceProposalItem,
} from '../_shared/learning-digest.js';
import {
  DEFAULT_PROVENANCE,
  type VoiceField,
  type VoiceProvenanceMap,
} from '../_shared/voice-learn-logic.js';

const ACTIONS = new Set([
  'approve_voice',
  'dismiss_voice',
  'undo_completion',
  'confirm_completion',
  'dismiss_completion',
]);

function findProposal(body: string, field: string): VoiceProposalItem | undefined {
  return parseVoiceProposals(body).find((p) => p.field === field);
}

export class ResolveLearningDigestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.workingDocs || !ctx.taskRepo || !ctx.entityMemory || !ctx.executiveProfileService) {
      return {
        success: false,
        error: 'resolve-learning-digest requires workingDocs, taskRepo, entityMemory, executiveProfileService',
      };
    }

    const input =
      ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const action = typeof input.action === 'string' ? input.action : '';
    if (!ACTIONS.has(action)) {
      return {
        success: false,
        error: `action must be one of: ${[...ACTIONS].join(', ')}`,
      };
    }

    if (action === 'approve_voice' || action === 'dismiss_voice') {
      const field = typeof input.field === 'string' ? input.field.trim() : '';
      if (!field) return { success: false, error: 'field is required for voice actions' };

      const doc = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
      if (!doc) return { success: false, error: 'No pending voice proposals' };
      const proposal = findProposal(doc.body, field);
      if (!proposal) return { success: false, error: `No pending proposal for field ${field}` };

      if (action === 'approve_voice') {
        const current = ctx.executiveProfileService.get().writingVoice;
        const patch = proposal.patch;
        const nextVoice = {
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
          ...(typeof patch.formality_delta === 'number'
            ? {
                formality: Math.max(
                  0,
                  Math.min(100, current.formality + (patch.formality_delta as number)),
                ),
              }
            : {}),
          ...(Array.isArray(patch.tone) ? { tone: patch.tone as string[] } : {}),
          ...(Array.isArray(patch.patterns) ? { patterns: patch.patterns as string[] } : {}),
        };
        await ctx.executiveProfileService.update(
          { writingVoice: nextVoice },
          'skill',
          `voice proposal approved: ${proposal.description}`,
        );

        const store = new ConfigStore(ctx.entityMemory, ctx.log);
        const raw = await store.get(VOICE_NS, PROVENANCE_KEY);
        let prov: VoiceProvenanceMap = { ...DEFAULT_PROVENANCE };
        if (raw) {
          try {
            prov = { ...DEFAULT_PROVENANCE, ...(JSON.parse(raw) as Partial<VoiceProvenanceMap>) };
          } catch {
            /* keep default */
          }
        }
        if (field in prov) {
          prov[field as VoiceField] = 'operator-set';
          await store.set(VOICE_NS, PROVENANCE_KEY, JSON.stringify(prov));
        }

        const updatedBody = markProposalStatus(doc.body, field, 'approved');
        await ctx.workingDocs.update(PENDING_PROPOSALS_PATH, {
          body: updatedBody,
          expectedVersion: doc.version,
        });
        return { success: true, data: { resolved: true, detail: `Approved voice ${field}` } };
      }

      // dismiss
      const store = new ConfigStore(ctx.entityMemory, ctx.log);
      const rawDismissed = await store.get(VOICE_NS, DISMISSED_KEY);
      let dismissed: Array<{ dimension: string; until: string }> = [];
      if (rawDismissed) {
        try {
          dismissed = JSON.parse(rawDismissed) as Array<{ dimension: string; until: string }>;
        } catch {
          dismissed = [];
        }
      }
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
      dismissed = dismissed.filter((d) => d.dimension !== field);
      dismissed.push({ dimension: field, until });
      await store.set(VOICE_NS, DISMISSED_KEY, JSON.stringify(dismissed));

      const updatedBody = markProposalStatus(doc.body, field, 'dismissed');
      await ctx.workingDocs.update(PENDING_PROPOSALS_PATH, {
        body: updatedBody,
        expectedVersion: doc.version,
      });
      return { success: true, data: { resolved: true, detail: `Dismissed voice ${field}` } };
    }

    // completion actions
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { success: false, error: 'task_id is required for completion actions' };

    const digest = await ctx.workingDocs.read(COMPLETION_DIGEST_PATH);
    if (!digest) return { success: false, error: 'No completion digest items' };

    if (action === 'undo_completion') {
      await ctx.taskRepo.reopenTask(taskId, 'Undo auto-complete from sent mail', ctx.agentId);
      const updatedBody = markCompletionStatus(digest.body, 'Undo', taskId, 'undone');
      await ctx.workingDocs.update(COMPLETION_DIGEST_PATH, {
        body: updatedBody,
        expectedVersion: digest.version,
      });
      return { success: true, data: { resolved: true, detail: `Reopened task ${taskId}` } };
    }

    if (action === 'confirm_completion') {
      const task = await ctx.taskRepo.getTask(taskId);
      if (task && task.status !== 'done') {
        await ctx.taskRepo.completeTask(
          taskId,
          'Confirmed complete from sent-mail digest',
          ctx.agentId,
        );
      }
      const updatedBody = markCompletionStatus(digest.body, 'Confirm', taskId, 'confirmed');
      await ctx.workingDocs.update(COMPLETION_DIGEST_PATH, {
        body: updatedBody,
        expectedVersion: digest.version,
      });
      return { success: true, data: { resolved: true, detail: `Confirmed completion ${taskId}` } };
    }

    // dismiss_completion
    const updatedBody = markCompletionStatus(digest.body, 'Confirm', taskId, 'dismissed');
    await ctx.workingDocs.update(COMPLETION_DIGEST_PATH, {
      body: updatedBody,
      expectedVersion: digest.version,
    });
    return { success: true, data: { resolved: true, detail: `Dismissed completion ${taskId}` } };
  }
}
