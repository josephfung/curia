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
import { buildCompletionDigestNotification } from '../_shared/learning-digest.js';
import { notifyLearningProposal } from '../_shared/learning-notify.js';

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
    if (!ctx.taskRepo || !ctx.sensitivityClassifier || !ctx.entityMemory) {
      return {
        success: false,
        error: 'task-completion-from-sent requires taskRepo, sensitivityClassifier, entityMemory',
      };
    }
    // Narrow closure over the classifier's classify() so classifyTaskRisk stays a pure,
    // testable helper that doesn't need to know about SkillContext (#1419). No structured
    // properties here — the title+tags text is already flattened by classifyTaskRisk, so
    // pass an empty properties bag (classify()'s second, required arg).
    const classify = (text: string) => ctx.sensitivityClassifier!.classify(text, {});

    const store = new ConfigStore(ctx.entityMemory, ctx.log);
    const candidateMap = await readCompletionCandidates(store, ctx.log);
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
    // Pending auto-completions: populated by the loop below but NOT yet applied — completeTask
    // only runs in the second pass after the digest write (carrying these tasks' undo notes) is
    // confirmed durable. See the big comment above the digest write for why.
    const toAutoComplete: Array<{
      taskId: string;
      candidateTaskId: string;
      subject: string;
      messageId: string;
    }> = [];

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
        // Durable-undo-before-complete (Finding 6): record the undo note and the pending
        // completion here, but do NOT call completeTask and do NOT delete the candidate from
        // `remaining` yet. Both happen only in the second pass below, after the digest write
        // carrying this note is confirmed durable — see the comment above that write.
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
        toAutoComplete.push({
          taskId: task.id,
          candidateTaskId: candidate.taskId,
          subject: candidate.subject,
          messageId: candidate.messageId,
        });
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

    // Durable-undo-before-complete ordering (Finding 6). The loop above populated `digestAdds`
    // (undo/confirm notes) and `toAutoComplete` (pending auto-completions) WITHOUT calling
    // completeTask and WITHOUT deleting auto-complete candidates from `remaining` — that only
    // happens in the second pass below, gated on this digest write actually landing. This closes
    // a gap in the previous ordering (complete → note → digest write): if the digest write
    // soft-rejected AFTER an auto-complete, the task was already 'done' by the next run, got
    // swept up as skipped_ineligible, and its undo note was gone with no recoverable trace. Under
    // this ordering, an auto-completed task can never exist without a recoverable undo
    // affordance already durably on record.
    //
    // One transient wart remains: if completeTask itself throws AFTER this digest write lands,
    // the digest briefly describes a task that isn't completed yet. This self-heals next run —
    // the task is still active, so it's re-evaluated, re-completed, and the note is overwritten
    // identically (composeUndoNote is a pure function of the same candidate fields).
    //
    // Confirm-queued and skip-ineligible items are unaffected by this restructure: they never
    // call completeTask, so they're deleted from `remaining` in the first loop as before — a lost
    // digest write there just means a clean re-classification (or re-skip) next run.
    //
    // digestStored also gates both the second-pass completion loop and the final candidate-
    // consume write: if the digest write soft-rejects (stored:false), we complete NOTHING and
    // consume NOTHING this run — every candidate (including ineligible-skip and confirm-queue
    // removals already computed in `remaining`) retries next run rather than persisting a
    // candidate-queue state that doesn't match what was actually recorded.
    let digestStored = true;
    if (digestAdds.length > 0) {
      const digestMap: CompletionDigestMap = await readCompletionDigest(store, ctx.log);
      for (const item of digestAdds) digestMap[item.taskId] = item;
      digestStored = await writeCompletionDigest(store, digestMap);
      if (!digestStored) {
        ctx.log.warn(
          {},
          'task-completion-from-sent: digest write soft-rejected — digest not durable, so no completions were applied and no candidates consumed; all retry next run',
        );
      }
    }

    // Second pass: only now that every pending auto-complete's undo note is confirmed durable is
    // it safe to actually complete the tasks.
    // Track which auto-completes actually landed this run so the notification below only tells the
    // CEO to "undo" tasks that were really marked done — a completeTask that threw leaves the task
    // active, and an "undo completion <id>" line for it would be a lie (the CEO reply path would
    // then find a non-done task and either fail loud or falsely report "already reopened").
    const completedTaskIds = new Set<string>();
    if (digestStored) {
      for (const pending of toAutoComplete) {
        try {
          await ctx.taskRepo.completeTask(
            pending.taskId,
            `Auto-completed from sent mail ${pending.messageId} (${pending.subject})`,
            ctx.agentId,
          );
          delete remaining[pending.candidateTaskId];
          completedTaskIds.add(pending.taskId);
          autoCompleted += 1;
        } catch (err) {
          ctx.log.error({ err, taskId: pending.taskId }, 'task-completion-from-sent: auto-complete failed');
          // Leave the candidate queued — completeTask failure is presumed transient (DB
          // hiccup), so it stays in `remaining` and retries next run. The undo note is already
          // durable and will be overwritten identically on retry, so nothing is lost.
          skipped += 1;
        }
      }
    }

    if (digestStored && Object.keys(remaining).length !== Object.keys(candidateMap).length) {
      await writeCompletionCandidates(store, remaining);
    }

    // Surface this run's newly produced items to the CEO the moment they're durably written (#1466).
    // After #1464 removed the scheduled digest, this event-driven notification is the only proactive
    // path that reaches the CEO for undo/confirm/dismiss. Include every confirm item (they don't
    // depend on completeTask) but only the undo items whose auto-complete actually succeeded this
    // run — an undo whose completeTask threw is still in `digestAdds`/the durable digest (which
    // self-heals next run), but must NOT be announced as done. Gated on digestStored (the durable
    // digest the reply resolves against) and non-empty. Best-effort — notify never fails the run.
    const notifyItems = digestAdds.filter(
      (i) => i.kind === 'confirm' || completedTaskIds.has(i.taskId),
    );
    if (digestStored && notifyItems.length > 0) {
      await notifyLearningProposal(ctx, buildCompletionDigestNotification(notifyItems));
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
