// handler.ts — onboarding-progress (#2360).
//
// The coordinator's view of, and writes to, the onboarding task: which topics are open, opening a
// later session's topics, marking a topic done or declined, recording the greeting, and operator
// notices. Only subtasks the onboarding program created count; onboarding completes once the
// ongoing-rhythm session is opened and every onboarding topic subtask is closed (done or declined).
// Completion is checked after each topic_done and again on every status, so a completion that
// failed once is retried; an open homework task is cancelled then.
//
// The task worked on is the turn's own task's root when that is a standalone deep-dive review task
// (#2362: drafts delivered with no onboarding open), else the open onboarding task, else the open
// deep-dive review task. A deep-dive task offers only the Review session and completes once its
// three document topics are closed.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { OnboardingService } from '../../../../src/onboarding/onboarding-service.js';
import type { PlaybookSession, PlaybookTopic } from '../../../../src/onboarding/playbook.js';
import type { TaskRepo } from '../../../../src/db/task-repo.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';
import { findOpenOnboardingTask, OPEN_STATUSES } from '../../../../src/onboarding/state.js';
import {
  DEEP_DIVE_TASK_TAG,
  ONBOARDING_CREATED_BY,
  REVIEW_DOCUMENT_TOPICS,
  REVIEW_SESSION,
} from '../../../../src/onboarding/constants.js';
import { boundTaskFromMetadata } from '../../../../src/agents/resumable-task.js';
import type { OperatorEvent } from '../../../../src/onboarding/notify-operator.js';
import {
  DECLINED_TAG,
  isOpenTask,
  listChildren,
  ONGOING_RHYTHM_SESSION,
  RECURRING_SESSION,
  topicSubtasks,
  type TopicSubtask,
} from '../../../../src/onboarding/subtasks.js';

const OPS = ['status', 'open_session', 'topic_done', 'greeting_sent', 'operator_notice'] as const;
/**
 * The only operator notice the model may raise (#2710): trouble only it can see. Unanswered
 * greetings, expired invitations and blocked sign-ins are raised by the code that detects them,
 * so letting the model raise those too would let a prompt-injected turn email the operator a
 * real-looking admin ask — and duplicate the watcher's own notice.
 */
const TOOL_OPERATOR_EVENTS = ['web_search_failed', 'deep_dive_delivery_failed'] as const;
const OUTCOMES = ['done', 'declined'] as const;
const NOTE_MAX = 2000;
const HOMEWORK_TAG = 'onboarding:homework';
/** How far up a task's parents the root lookup walks before giving up. */
const ROOT_DEPTH_MAX = 20;

type Deps = { svc: OnboardingService; repo: TaskRepo; parent: TaskRow; ctx: ToolContext };

const fail = (error: string): ToolResult => ({ success: false, error });

function fillName(text: string, name: string): string {
  return text.replaceAll('{principal}', name);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Playbook topics keyed by `<sessionId>/<topicId>`. */
function topicIndex(sessions: PlaybookSession[]): Map<string, PlaybookTopic> {
  const index = new Map<string, PlaybookTopic>();
  for (const s of sessions) for (const t of s.topics) if (!index.has(`${s.id}/${t.id}`)) index.set(`${s.id}/${t.id}`, t);
  return index;
}

export class OnboardingProgressHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const svc = ctx.onboardingService;
    const repo = ctx.taskRepo;
    if (!svc || !repo) return fail('onboarding-progress requires the onboardingService and taskRepo capabilities');
    const input = (ctx.input ?? {}) as Record<string, unknown>;
    const op = input.op;
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
      return fail(`op must be one of: ${OPS.join(', ')}`);
    }
    try {
      const parent = await resolveParent(repo, ctx);
      if (!parent) return fail('No onboarding is under way: there is no open onboarding task or deep-dive review task.');
      const deps: Deps = { svc, repo, parent, ctx };
      switch (op) {
        case 'status': return await status(deps);
        case 'open_session': return await openSession(deps, input);
        case 'topic_done': return await topicDone(deps, input);
        case 'greeting_sent': return await greetingSent(deps);
        default: return await operatorNotice(deps, input);
      }
    } catch (err) {
      ctx.log.error({ err, op }, 'onboarding-progress failed');
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

/** A standalone deep-dive review task: tagged deep-dive and made by onboarding (a tag alone is spoofable). */
function isDeepDiveTask(task: TaskRow): boolean {
  return task.tags.includes(DEEP_DIVE_TASK_TAG) && task.createdBy === ONBOARDING_CREATED_BY;
}

/**
 * The task this call works on: the turn's own task's root when it is an open deep-dive review
 * task, else the open onboarding task, else the open deep-dive review task (a principal's reply
 * that arrived bound to no task, after onboarding).
 */
async function resolveParent(repo: TaskRepo, ctx: ToolContext): Promise<TaskRow | null> {
  const bound = boundTaskFromMetadata(ctx.taskMetadata);
  if (bound) {
    const root = await rootTask(repo, bound.taskId);
    if (root && isDeepDiveTask(root) && isOpenTask(root)) return root;
  }
  const onboarding = await findOpenOnboardingTask(repo);
  if (onboarding) return onboarding;
  // Open ones only, filtered in the query: closed review tasks must not crowd the open one off the page.
  const reviews = await repo.listTasks({ tag: DEEP_DIVE_TASK_TAG, statuses: OPEN_STATUSES, createdBy: ONBOARDING_CREATED_BY, limit: 10 });
  return reviews.find((t) => t.parentTaskId === null && isOpenTask(t)) ?? null;
}

/** The top of a task's parent chain, or null when a task on it is missing or the chain is too deep. */
async function rootTask(repo: TaskRepo, taskId: string): Promise<TaskRow | null> {
  let task = await repo.getTask(taskId);
  for (let depth = 0; task && task.parentTaskId !== null; depth++) {
    if (depth >= ROOT_DEPTH_MAX) return null;
    task = await repo.getTask(task.parentTaskId);
  }
  return task;
}

function isReviewDocumentTopic(topicId: string): boolean {
  return (REVIEW_DOCUMENT_TOPICS as readonly string[]).includes(topicId);
}

/** The playbook sessions this parent offers: only Review on a standalone deep-dive review task. */
function offeredSessions(parent: TaskRow, sessions: PlaybookSession[]): PlaybookSession[] {
  const own = sessions.filter((s) => s.id !== RECURRING_SESSION);
  return isDeepDiveTask(parent) ? own.filter((s) => s.id === REVIEW_SESSION) : own;
}

function describeTopic(sub: TopicSubtask, index: Map<string, PlaybookTopic>, name: string) {
  const topic = index.get(`${sub.sessionId}/${sub.topicId}`);
  return {
    topicId: sub.topicId,
    title: fillName(topic?.title ?? sub.task.title, name),
    body: fillName(topic?.body ?? '', name),
    needsMailbox: topic?.needsMailbox ?? false,
  };
}

/**
 * Complete the onboarding task if it is done: the ongoing-rhythm session opened, every
 * onboarding topic subtask closed, and no deep dive (#2362) still scanning or drafting, whose
 * drafts would otherwise arrive after onboarding ended. Other children (homework, tasks the model
 * parented here) do not hold it open; an open homework task is cancelled. Idempotent: a parent
 * already closed is left. A standalone deep-dive review task completes on its topics alone.
 * Returns whether the task is complete.
 */
async function completeIfDone({ svc, repo, parent, ctx }: Deps): Promise<boolean> {
  // Read the run state before the children: the hand-off opens the Review topics before it marks
  // the run delivered, so a run seen as not running has its topics in the snapshot below.
  const deepDiveRunning = await svc.deepDiveRunning();
  const children = await listChildren(repo, parent.id);
  const topics = topicSubtasks(children, ctx.log);
  if (isDeepDiveTask(parent)) {
    // A standalone review task is done once its document topics are closed. Next step (a rhythm
    // question for onboarding) does not hold it open; an open one is cancelled with it.
    const docs = topics.filter((t) => t.sessionId === REVIEW_SESSION && isReviewDocumentTopic(t.topicId));
    if (docs.length === 0) {
      ctx.log.warn({ taskId: parent.id }, 'onboarding: the deep-dive review task has no review topics, so it cannot complete on them');
      return false;
    }
    if (docs.some((t) => isOpenTask(t.task))) return false;
    for (const t of topics) {
      if (isOpenTask(t.task)) await repo.updateTask(t.task.id, { status: 'cancelled', progressNote: 'Deep-dive review complete: not needed.' }, ctx.agentId);
    }
    await repo.completeTask(parent.id, 'Deep-dive review complete: every document is reviewed.', ctx.agentId);
    ctx.log.info({ taskId: parent.id }, 'onboarding: deep-dive review complete');
    return true;
  }
  if (!topics.some((t) => t.sessionId === ONGOING_RHYTHM_SESSION)) return false;
  if (topics.some((t) => isOpenTask(t.task))) return false;
  if (deepDiveRunning) {
    ctx.log.info({ taskId: parent.id }, 'onboarding: every topic is closed, but the deep dive is still running');
    return false;
  }
  for (const child of children) {
    if (child.createdBy !== ONBOARDING_CREATED_BY || !child.tags.includes(HOMEWORK_TAG) || !isOpenTask(child)) continue;
    await repo.updateTask(child.id, { status: 'cancelled', progressNote: 'Onboarding complete: homework closed.' }, ctx.agentId);
  }
  await repo.completeTask(parent.id, 'Onboarding complete: every topic is done.', ctx.agentId);
  ctx.log.info({ taskId: parent.id }, 'onboarding: complete');
  return true;
}

async function status(deps: Deps): Promise<ToolResult> {
  const { svc, repo, parent, ctx } = deps;
  // A completion that failed after the last topic_done is retried here.
  // A failure here must not hide the topics: report not complete and carry on.
  let onboardingComplete = false;
  try {
    onboardingComplete = await completeIfDone(deps);
  } catch (err) {
    ctx.log.warn({ err, taskId: parent.id }, 'onboarding: completing the onboarding task failed during status — topics still returned');
  }
  const [playbook, children, name, state, setup, mailboxConnected] = await Promise.all([
    svc.playbook(),
    listChildren(repo, parent.id),
    svc.principalDisplayName(),
    svc.readState(),
    svc.setupContext(),
    isMailboxConnected(ctx),
  ]);
  // The weekly section is for recurring sessions after onboarding, not onboarding topics.
  const sessions = offeredSessions(parent, playbook);
  const subs = topicSubtasks(children, ctx.log);
  const index = topicIndex(sessions);
  // Playbook sessions in order, then any session a subtask names that the playbook no longer has.
  const known = sessions.map((s) => ({ id: s.id, title: s.title }));
  for (const sub of subs) {
    if (sub.sessionId && !known.some((s) => s.id === sub.sessionId)) known.push({ id: sub.sessionId, title: sub.sessionId });
  }
  return {
    success: true,
    data: {
      taskId: parent.id,
      sessions: known.map((s) => {
        const mine = subs.filter((sub) => sub.sessionId === s.id);
        return {
          id: s.id,
          title: fillName(s.title, name),
          opened: mine.length > 0,
          open: mine.filter((sub) => isOpenTask(sub.task)).map((sub) => describeTopic(sub, index, name)),
          done: mine
            .filter((sub) => sub.task.status === 'done')
            .map((sub) => ({ topicId: sub.topicId, title: fillName(index.get(`${s.id}/${sub.topicId}`)?.title ?? sub.task.title, name) })),
        };
      }),
      mailboxConnected,
      greetingSent: state?.greetingSentAt != null,
      setupFor: setup.setupFor,
      operatorName: setup.operatorName,
      onboardingComplete,
    },
  };
}

async function openSession({ svc, repo, parent, ctx }: Deps, input: Record<string, unknown>): Promise<ToolResult> {
  const sessionId = str(input.session_id);
  if (!sessionId) return fail('open_session requires session_id');
  if (isDeepDiveTask(parent) && sessionId !== REVIEW_SESSION) {
    return fail(`A deep-dive review task has only the ${REVIEW_SESSION} session.`);
  }
  const opened = await svc.openSession(parent, sessionId);
  if (!opened.ok) return fail(`Unknown session_id '${sessionId}'. Playbook sessions: ${opened.sessionIds.join(', ') || '(none)'}`);
  const [children, name] = await Promise.all([listChildren(repo, parent.id), svc.principalDisplayName()]);
  const index = topicIndex([opened.session]);
  const subs = topicSubtasks(children, ctx.log).filter((s) => s.sessionId === opened.session.id);
  return {
    success: true,
    data: {
      sessionId: opened.session.id,
      title: fillName(opened.session.title, name),
      createdSubtasks: opened.createdSubtasks,
      topics: subs.map((sub) => ({ ...describeTopic(sub, index, name), status: isOpenTask(sub.task) ? 'open' : sub.task.status })),
    },
  };
}

async function topicDone(deps: Deps, input: Record<string, unknown>): Promise<ToolResult> {
  const { repo, parent, ctx } = deps;
  const topicId = str(input.topic_id);
  const sessionId = str(input.session_id);
  const outcome = input.outcome;
  const note = str(input.note);
  if (!topicId) return fail('topic_done requires topic_id');
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) {
    return fail(`topic_done requires outcome: ${OUTCOMES.join(' or ')}`);
  }
  if (!note) return fail('topic_done requires a note: what was chosen and applied, or why it was declined');

  const open = topicSubtasks(await listChildren(repo, parent.id), ctx.log).filter((s) => isOpenTask(s.task));
  const matches = open.filter((s) => s.topicId === topicId && (!sessionId || s.sessionId === sessionId));
  if (matches.length === 0) {
    const valid = open.map((s) => `${s.topicId} (${s.sessionId ?? 'no session'})`);
    return fail(`No open onboarding topic '${topicId}'${sessionId ? ` in session '${sessionId}'` : ''}. Open topics: ${valid.join(', ') || '(none)'}`);
  }
  if (matches.length > 1) {
    return fail(`Topic '${topicId}' is open in more than one session (${matches.map((m) => m.sessionId).join(', ')}); pass session_id.`);
  }
  const sub = matches[0]!;
  const text = note.slice(0, NOTE_MAX);
  // Recorded before completing, so a declined topic can never read as done (triage release checks it).
  const declined = outcome === 'declined';
  const tags = declined
    ? [...new Set([...sub.task.tags, DECLINED_TAG])]
    : sub.task.tags.filter((t) => t !== DECLINED_TAG);
  if (tags.length !== sub.task.tags.length) await repo.updateTask(sub.task.id, { tags }, ctx.agentId);
  await repo.completeTask(sub.task.id, outcome === 'declined' ? `Declined: ${text}` : text, ctx.agentId);

  // The topic is closed whatever happens next: a failed completion is retried on the next status.
  let onboardingComplete = false;
  try {
    onboardingComplete = await completeIfDone(deps);
  } catch (err) {
    ctx.log.error({ err, taskId: parent.id }, 'onboarding: completing the onboarding task failed — status retries it');
    return {
      success: true,
      data: {
        topicId, sessionId: sub.sessionId, outcome, onboardingComplete: false,
        completionPending: 'Every topic is closed, but the onboarding task could not be completed. Call op status to retry.',
      },
    };
  }
  return { success: true, data: { topicId, sessionId: sub.sessionId, outcome, onboardingComplete } };
}

/** Whether any principal mailbox is connected. A directory error reads as not connected. */
async function isMailboxConnected(ctx: ToolContext): Promise<boolean> {
  if (!ctx.mailboxDirectory) return false;
  try {
    return (await ctx.mailboxDirectory.list()).length > 0;
  } catch (err) {
    ctx.log.warn({ err }, 'onboarding-progress: mailbox directory unreadable — reporting no mailbox connected');
    return false;
  }
}

async function greetingSent({ svc }: Deps): Promise<ToolResult> {
  const at = await svc.markGreetingSent();
  if (!at) return fail('Onboarding has no recorded state, so the greeting cannot be recorded.');
  return { success: true, data: { recorded: true } };
}

async function operatorNotice({ svc, parent }: Deps, input: Record<string, unknown>): Promise<ToolResult> {
  const event = input.event;
  if (typeof event !== 'string' || !(TOOL_OPERATOR_EVENTS as readonly string[]).includes(event)) {
    return fail(`operator_notice requires event: one of ${TOOL_OPERATOR_EVENTS.join(', ')}`);
  }
  const details = input.details;
  if (details !== undefined && (typeof details !== 'object' || details === null || Array.isArray(details))) {
    return fail('details must be an object when given');
  }
  // Model-supplied details go no further than the task note, the log and the audit row — the
  // email carries the event only (#2710).
  const notice = { details: details as Record<string, unknown> | undefined };
  // Once, like every other operator notice: per onboarding run on the onboarding task (the
  // watcher's dedupe), per event on a deep-dive review task. A repeat records and emails nothing.
  const result = await svc.raiseOperatorNotice(parent.id, event as OperatorEvent, notice);
  // Already raised this run is success, not a failure: it is the dedupe working, and telling the
  // model to retry would only make it loop. Nothing is emailed a second time (#2710).
  if (result.alreadyRaised) return { success: true, data: { alreadyRaised: true } };
  if (!result.recorded) return fail('The operator notice could not be recorded on the task. Try again shortly.');
  return { success: true, data: { recorded: true } };
}
