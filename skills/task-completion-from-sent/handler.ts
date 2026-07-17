// task-completion-from-sent — risk-tiered completion from Sent matches (#1424).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import {
  classifyTaskRisk,
  decideCompletionAction,
  type CompletionAction,
  type TaskRisk,
} from '../_shared/task-completion-risk.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import {
  readCompletionCandidates,
  writeCompletionCandidates,
  readCompletionDigest,
  writeCompletionDigest,
  composeUndoNote,
  composeConfirmNote,
  type CompletionCandidateMap,
  type CompletionDigestMap,
  type CompletionDigestItem,
} from '../_shared/learning-state.js';

// Active (non-terminal) task statuses eligible for sent-mail completion. Mirrors the
// active-status set used by the scheduler/backlog queries (src/db/queries/tasks.ts).
// Using an explicit allow-list (rather than excluding only done/cancelled) ensures
// terminal statuses like 'failed' are skipped — a confident match must never resurrect
// a terminated task as done.
const ACTIVE_TASK_STATUSES = new Set(['open', 'in_progress', 'waiting', 'blocked']);

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
    const digestAdds: CompletionDigestItem[] = [];

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
          digestAdds.push({
            kind: 'undo',
            taskId: task.id,
            taskTitle: task.title || candidate.taskTitle,
            note: composeUndoNote({
              taskTitle: task.title || candidate.taskTitle,
              recipient,
              sentAt: candidate.sentAt,
            }),
          });
          delete remaining[candidate.taskId];
          autoCompleted += 1;
        } catch (err) {
          ctx.log.error({ err, taskId: task.id }, 'task-completion-from-sent: auto-complete failed');
          // Leave the candidate queued — completeTask failure is presumed transient (DB
          // hiccup), so it stays in remaining and retries next run rather than being lost.
          skipped += 1;
        }
      } else {
        digestAdds.push({
          kind: 'confirm',
          taskId: task.id,
          taskTitle: task.title || candidate.taskTitle,
          note: composeConfirmNote({
            taskTitle: task.title || candidate.taskTitle,
            recipient,
          }),
        });
        delete remaining[candidate.taskId];
        queuedConfirm += 1;
      }
    }

    // Digest-first ordering: write the undo/confirm digest items BEFORE consuming the
    // candidate map. Neither write reads the other's result, so the happy path is
    // unaffected — but if the process dies between the two writes, digest-first is the
    // safer failure mode. A completed/skip-worthy task is already terminal (done, or no
    // longer active) by the time we'd retry, so a lost candidate-consume write just makes
    // the stale candidate get re-skipped next run (ineligible → removed, no re-complete,
    // no duplicate digest item). Consume-first would instead silently drop the undo/confirm
    // affordance the user needed while leaving no trace that one was ever queued.
    if (digestAdds.length > 0) {
      const digestMap: CompletionDigestMap = await readCompletionDigest(store);
      for (const item of digestAdds) digestMap[item.taskId] = item;
      await writeCompletionDigest(store, digestMap);
    }

    if (Object.keys(remaining).length !== Object.keys(candidateMap).length) {
      await writeCompletionCandidates(store, remaining);
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
