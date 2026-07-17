// task-completion-from-sent — risk-tiered completion from Sent matches (#1424).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { VOICE_LEARNING_SCRATCH_PREFIX } from '../_shared/voice-learning-capture.js';
import {
  classifyTaskRisk,
  decideCompletionAction,
  formatConfirmNote,
  formatUndoNote,
  type CompletionAction,
  type TaskRisk,
} from '../_shared/task-completion-risk.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import {
  readCompletionCandidates,
  writeCompletionCandidates,
  type CompletionCandidateMap,
} from '../_shared/learning-state.js';

export const COMPLETION_DIGEST_PATH = `${VOICE_LEARNING_SCRATCH_PREFIX}/completion-digest.md`;
export const COMPLETION_DIGEST_TYPE = 'task-completion-digest';

// Active (non-terminal) task statuses eligible for sent-mail completion. Mirrors the
// active-status set used by the scheduler/backlog queries (src/db/queries/tasks.ts).
// Using an explicit allow-list (rather than excluding only done/cancelled) ensures
// terminal statuses like 'failed' are skipped — a confident match must never resurrect
// a terminated task as done.
const ACTIVE_TASK_STATUSES = new Set(['open', 'in_progress', 'waiting', 'blocked']);

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

export class TaskCompletionFromSentHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // Skill contract: never throw — normalize repo/document failures to a result.
    try {
      return await this.runCompletion(ctx);
    } catch (err) {
      ctx.log.error({ err }, 'task-completion-from-sent: unexpected failure');
      return {
        success: false,
        error: `task-completion-from-sent failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async runCompletion(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.taskRepo || !ctx.workingDocs || !ctx.sensitivityClassifier || !ctx.entityMemory) {
      return {
        success: false,
        error: 'task-completion-from-sent requires taskRepo, workingDocs, sensitivityClassifier, entityMemory',
      };
    }
    // Narrow closure over the classifier's classify() so classifyTaskRisk stays a pure,
    // testable helper that doesn't need to know about SkillContext (#1419). No structured
    // properties here — the title+tags text is already flattened by classifyTaskRisk, so
    // pass an empty properties bag (classify()'s second, required arg).
    const classify = (text: string) => ctx.sensitivityClassifier!.classify(text, {});

    const store = new ConfigStore(ctx.entityMemory, ctx.log);
    const candidateMap = await readCompletionCandidates(store);
    const candidates = Object.entries(candidateMap).map(([taskId, c]) => ({ taskId, ...c }));
    if (candidates.length === 0) {
      return { success: true, data: { auto_completed: 0, queued_confirm: 0, skipped: 0 } };
    }
    // Consume-by-delete: every candidate processed below (auto-completed, confirm-queued, or
    // skipped-ineligible) is removed here. The persistent asked_task_ids guard (written by
    // sent-observe) is what stops a task from being re-surfaced, so removal is always safe —
    // there's no in-band "already asked" marker to preserve any more.
    const remaining: CompletionCandidateMap = { ...candidateMap };
    let autoCompleted = 0;
    let queuedConfirm = 0;
    let skipped = 0;
    const digestChunks: string[] = [];

    for (const candidate of candidates) {
      const task = await ctx.taskRepo.getTask(candidate.taskId);
      // Re-validate eligibility: the candidate may be stale (task reassigned, completed,
      // cancelled, or failed since observation). Only active CEO-owned tasks may be
      // completed — this enforces the documented owner='ceo', still-active boundary.
      const eligible =
        !!task &&
        task.owner === 'ceo' &&
        ACTIVE_TASK_STATUSES.has(task.status);
      if (!eligible) {
        skipped += 1;
        delete remaining[candidate.taskId];
        continue;
      }

      // Low-confidence matches always go to confirm — auto-complete requires HIGH confidence, so
      // risk classification (the subtask lookup + sensitivity classify) is wasted work for them.
      // Only classify risk for high-confidence candidates (T3.1); low-confidence risk stays
      // undefined ("unassessed") and is shown as such in the confirm digest.
      let action: CompletionAction = 'confirm';
      let risk: TaskRisk | undefined;
      if (candidate.confidence === 'high') {
        // Detect subtasks via parent lookups when available. Fail CLOSED: if the lookup
        // errors we cannot rule out subtasks, so treat the task as high-risk rather than
        // risk auto-completing a parent (which would cancel its descendants).
        let hasSubtasks = false;
        try {
          const children = await ctx.taskRepo.listTasks({
            parentTaskId: task.id,
            limit: 5,
          });
          hasSubtasks = children.length > 0;
        } catch (err) {
          ctx.log.warn(
            { err, taskId: task.id },
            'task-completion-from-sent: subtask lookup failed — treating as high risk',
          );
          hasSubtasks = true;
        }

        risk = classifyTaskRisk(
          {
            id: task.id,
            title: task.title,
            description: task.description,
            priority: task.priority,
            tags: task.tags,
            progress: task.progress,
            hasSubtasks,
          },
          classify,
        );
        action = decideCompletionAction(risk);
      }
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
          delete remaining[candidate.taskId];
          autoCompleted += 1;
        } catch (err) {
          ctx.log.error({ err, taskId: task.id }, 'task-completion-from-sent: auto-complete failed');
          // Leave the candidate queued — completeTask failure is presumed transient (DB
          // hiccup), so it stays in remaining and retries next run rather than being lost.
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
        delete remaining[candidate.taskId];
        queuedConfirm += 1;
      }
    }

    if (Object.keys(remaining).length !== Object.keys(candidateMap).length) {
      await writeCompletionCandidates(store, remaining);
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
