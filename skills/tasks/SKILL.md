---
name: tasks
description: >
  Defer, track, and resume multi-step work with task-create/list/update/complete.
  Pin this skill to make an agent heartbeat-eligible.
version: "0.1.0"
heartbeat: true
tools:
  - task-create
  - task-list
  - task-update
  - task-complete
---

## Task Management

You can defer, track, and resume work using your task skills.

**Decide, don't drop.** When work arrives that you cannot finish now, create a
task (`task-create`, optionally with `wake_at`) rather than cramming it into one
burst or abandoning it. Briefly tell the CEO what you queued and why.

**Own the how.** When a clear goal is too big for one burst, decompose it and start —
with a one-line heads-up. Do not ask the CEO how to execute (splitting, scheduling,
budgets); ask only about the goal itself, or a consequential or hard-to-reverse action.

**Decompose projects.** If work has more than one step, or any step cannot be done
right now, create a parent task whose `intent_anchor` states the durable goal, plus
the first wave of subtasks (`parent_task_id`, and `blocked_by_task_id` for ordering).
Plan the first wave only; add subtasks as you learn more.

**Make every subtask self-contained.** A woken subtask starts fresh with no memory of this
conversation — it has only its id, title, intent, and progress note (see Resuming below).
So its `intent_anchor` and progress must fully re-establish the work: the goal, the resource
(e.g. a URL), and precise progress ("answered Q1-12 of 60"). A bare title like "Answer
Q13-36" strands the wake.

If a subtask works through the **web-browser** skill, do not assume its live browser session
survives a wake: record the URL, the exact `session_id`, and whether the session was
`incognito`. On wake, reuse that `session_id`; if the tool reports it is gone, re-open in the
same mode (an incognito flow must not fall back into the principal's persistent profile) and
resume from the URL and recorded progress.

**Advance until blocked.** When you act on a task, do every step you can right now.
Stop only at a real blocker — waiting on a person, on the CEO's approval, on a future
date, or on a prior task — or when your turn budget runs low. Then park each loose end:
set its status (`waiting`/`blocked`), add a progress note, and set a wake (a reply you
are expecting, or a `wake_at` timer).

**Past-due milestones.** Never `task-complete` a subtask whose milestone `due_at` was
already in the past when you created it — run its work immediately (the platform will
wake it now) or escalate. Do not mark it done with a "past due, auto-completed" note.

**Never promise without a task.** Before you send anything that commits to a future
action ("I'll follow up with X", "we'll send that over"), make sure a task backs that
promise. Prefer to resolve the dependency first and send a complete message. Only send
an interim "I'll follow up" when the recipient needs an acknowledgment now — and when
you do, create the follow-up task (yours if you can chase it; the CEO's if only they
can, and tell them).

**Resuming.** When you are woken to advance a task, you receive its id, title, intent,
and progress. Pick up where you left off. You may pull your other ready tasks
(`task-list`) and advance them too, in dependency order, until blocked or budget-bound.
