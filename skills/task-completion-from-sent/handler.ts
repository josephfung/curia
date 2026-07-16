// task-completion-from-sent — risk-tiered completion from Sent matches (#1424).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { PENDING_COMPLETIONS_PATH } from '../ceo-inbox-sent-observe/handler.js';
import { VOICE_LEARNING_SCRATCH_PREFIX } from '../_shared/voice-learning-capture.js';
import {
  classifyTaskRisk,
  decideCompletionAction,
  formatConfirmNote,
  formatUndoNote,
  parseCompletionCandidates,
} from '../_shared/task-completion-risk.js';

export const COMPLETION_DIGEST_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/completion-digest.md`;
export const COMPLETION_DIGEST_TYPE = 'task-completion-digest';

async function appendDigest(ctx: SkillContext, content: string): Promise<void> {
  const repo = ctx.workingDocs!;
  const existing = await repo.read(COMPLETION_DIGEST_PATH);
  if (!existing) {
    await repo.create({
      path: COMPLETION_DIGEST_PATH,
      type: COMPLETION_DIGEST_TYPE,
      frontmatter: { title: 'Task completion digest' },
      body: `# Task completion digest\n\n${content}`,
      agentId: ctx.agentId,
    });
    return;
  }
  await repo.append(COMPLETION_DIGEST_PATH, {
    content,
    expectedVersion: existing.version,
  });
}

function markCandidateProcessed(body: string, taskId: string, marker: string): string {
  const re = new RegExp(
    `(## Candidate — task ${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?)(- status:\\s*)pending`,
  );
  if (re.test(body)) {
    return body.replace(re, `$1$2${marker}`);
  }
  // Fallback: append guard marker near the candidate header.
  return body.replace(
    `## Candidate — task ${taskId}`,
    `## Candidate — task ${taskId}\n- ${marker}\n- completion_asked: {${new Date().toISOString().slice(0, 10)}}`,
  );
}

export class TaskCompletionFromSentHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.taskRepo || !ctx.workingDocs) {
      return {
        success: false,
        error: 'task-completion-from-sent requires taskRepo and workingDocs',
      };
    }

    const pendingDoc = await ctx.workingDocs.read(PENDING_COMPLETIONS_PATH);
    if (!pendingDoc) {
      return {
        success: true,
        data: { auto_completed: 0, queued_confirm: 0, skipped: 0 },
      };
    }

    const candidates = parseCompletionCandidates(pendingDoc.body);
    let autoCompleted = 0;
    let queuedConfirm = 0;
    let skipped = 0;
    let body = pendingDoc.body;
    const digestChunks: string[] = [];

    for (const candidate of candidates) {
      const task = await ctx.taskRepo.getTask(candidate.taskId);
      if (!task || task.status === 'done' || task.status === 'cancelled') {
        skipped += 1;
        body = markCandidateProcessed(body, candidate.taskId, 'skipped_missing_or_done');
        continue;
      }

      // Detect subtasks via parent lookups when available.
      let hasSubtasks = false;
      try {
        const children = await ctx.taskRepo.listTasks({
          parentTaskId: task.id,
          limit: 5,
        });
        hasSubtasks = children.length > 0;
      } catch {
        hasSubtasks = false;
      }

      const risk = classifyTaskRisk({
        id: task.id,
        title: task.title,
        priority: task.priority,
        tags: task.tags,
        progress: task.progress,
        hasSubtasks,
      });
      const action = decideCompletionAction(risk, candidate.confidence);
      const recipient = candidate.recipients[0] ?? 'them';

      if (action === 'auto_complete') {
        try {
          await ctx.taskRepo.completeTask(
            task.id,
            `Auto-completed from sent mail ${candidate.messageId} (${candidate.subject})`,
            ctx.agentId,
          );
          digestChunks.push(
            formatUndoNote({
              taskId: task.id,
              taskTitle: task.title || candidate.taskTitle,
              recipient,
              sentAt: candidate.sentAt,
            }),
          );
          body = markCandidateProcessed(body, candidate.taskId, 'auto_completed');
          autoCompleted += 1;
        } catch (err) {
          ctx.log.error({ err, taskId: task.id }, 'task-completion-from-sent: auto-complete failed');
          skipped += 1;
        }
      } else {
        digestChunks.push(
          formatConfirmNote({
            taskId: task.id,
            taskTitle: task.title || candidate.taskTitle,
            recipient,
            sentAt: candidate.sentAt,
            confidence: candidate.confidence,
            risk,
          }),
        );
        body = markCandidateProcessed(body, candidate.taskId, 'confirm_queued');
        // In-band guard so fuzzy candidates aren't re-surfaced.
        if (!body.includes(`completion_asked:`) || !body.includes(candidate.taskId)) {
          body = body.replace(
            `## Candidate — task ${candidate.taskId}`,
            `## Candidate — task ${candidate.taskId}\n- completion_asked: {${new Date().toISOString().slice(0, 10)}}`,
          );
        }
        queuedConfirm += 1;
      }
    }

    if (body !== pendingDoc.body) {
      await ctx.workingDocs.update(PENDING_COMPLETIONS_PATH, {
        body,
        expectedVersion: pendingDoc.version,
      });
    }

    if (digestChunks.length > 0) {
      await appendDigest(ctx, digestChunks.join(''));
    }

    ctx.log.info(
      { autoCompleted, queuedConfirm, skipped },
      'task-completion-from-sent: run complete',
    );

    return {
      success: true,
      data: {
        auto_completed: autoCompleted,
        queued_confirm: queuedConfirm,
        skipped,
      },
    };
  }
}
