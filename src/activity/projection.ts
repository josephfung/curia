// projection.ts — turn audit_log rows into job-level activity items (#2251).
//
// Pure: the caller (activity-service.ts) reads the rows and resolves names and
// job labels first, so this file does no I/O and makes no model calls.
//
// How rows group into a job. task_id is NULL on a job's own rows, so the key
// is the agent.task event id:
//   - tool.invoke, agent.response and activity.summary have it as parent_event_id
//   - tool.result is one level further down (its parent is the tool.invoke)
//   - a delegated specialist's agent.task carries the delegating task's id in
//     payload.metadata.delegationOrigin.taskEventId, so its work folds into the
//     root job instead of reading as "handed off to …"

import type { AuditLogRow } from '../audit/audit-log-repo.js';
import { readAuditToolName } from '../audit/legacy-tool-events.js';
import type { ActionLogRow } from '../autonomy/action-log-types.js';
import { parseSchedulerRunJobId } from '../scheduler/conversation-id.js';
import {
  describeToolCall,
  describerRefs,
  formatTally,
  notDoneText,
  researchKind,
  type DescribeContext,
  type Tally,
  type ToolCall,
  type ToolDescription,
} from './describers.js';
import {
  EMPTY_CATALOG,
  GENERIC_ACTION_ATTEMPT,
  GENERIC_ACTION_TALLY,
  type DescriberCatalog,
} from './learned-describers.js';
import type { ActivityAutonomy, ActivityItem, ActivityLink, ActivityOutcome } from './types.js';

/** What the repo hands the projection (AuditLogRepo.findActivityJobs). */
export interface ActivityRows {
  /** Root agent.task rows, newest first. */
  roots: AuditLogRow[];
  /** Delegated specialist agent.task rows under those roots, any order. */
  delegated: AuditLogRow[];
  /** tool.invoke / tool.result / agent.response / activity.summary rows under any of the tasks. */
  children: AuditLogRow[];
}

export interface ProjectionContext extends DescribeContext {
  /** Human label for a scheduled job id, or null when the job is unknown. */
  jobLabel(jobId: string): string | null;
  /** Terminal autonomy_action_log rows covering the window. */
  autonomyRows: ActionLogRow[];
  /** Learned describers and known writes for tools with no code describer (ADR-059). */
  catalog?: DescriberCatalog;
}

/** Everything the service must resolve before projecting. */
export interface ActivityRefs {
  names: Set<string>;
  jobIds: Set<string>;
}

const INVOKE_TYPES = new Set(['tool.invoke', 'skill.invoke']);
const RESULT_TYPES = new Set(['tool.result', 'skill.result']);
/** Channels whose agent.task never came from a person. */
const NON_CONVERSATIONAL_CHANNELS = new Set(['scheduler', 'internal']);
const AUTONOMY_MATCH_WINDOW_MS = 5 * 60 * 1000;
/** Padding around a job's span on the Ant Farm replay link. */
const LINK_PAD_MS = 60 * 1000;

interface Call extends ToolCall {
  /** The agent whose task made the call: a delegated specialist, not the root's agent. */
  agentId: string;
  taskEventId: string;
  conversationId: string | null;
  ts: Date;
}

interface Job {
  root: AuditLogRow;
  taskIds: Set<string>;
  calls: Call[];
  rootResponse: AuditLogRow | null;
  summary: string | null;
  endTs: Date;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function delegationOriginOf(task: AuditLogRow): string | null {
  const origin = rec(rec(task.payload.metadata)?.delegationOrigin);
  const id = origin?.taskEventId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function agentOf(task: AuditLogRow): string {
  const agentId = task.payload.agentId;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : task.sourceId;
}

function readCallOk(row: AuditLogRow): boolean {
  // Structured outcome column first; payload for pre-hardening rows.
  if (row.outcome === 'success') return true;
  if (row.outcome === 'failure' || row.outcome === 'error' || row.outcome === 'denied') return false;
  return rec(row.payload.result)?.success === true;
}

/**
 * A failed call that a policy guard held or refused by design (#2587). Read from the
 * structured errorType the send skills set, never from the error text. Same rule as
 * the briefing histogram, so the feed and the Hiccups tile agree.
 */
function readCallHeld(row: AuditLogRow): boolean {
  return rec(row.payload.result)?.errorType === 'POLICY_HOLD';
}

/** Group the rows into jobs keyed by root agent.task id, roots newest first. */
function buildJobs(rows: ActivityRows): Job[] {
  const jobs = new Map<string, Job>();
  const rootOfTask = new Map<string, string>();
  const agentOfTask = new Map<string, string>();
  for (const task of [...rows.roots, ...rows.delegated]) agentOfTask.set(task.id, agentOf(task));
  for (const root of rows.roots) {
    jobs.set(root.id, {
      root,
      taskIds: new Set([root.id]),
      calls: [],
      rootResponse: null,
      summary: null,
      endTs: root.timestamp,
    });
    rootOfTask.set(root.id, root.id);
  }

  // Specialist tasks can delegate in turn, so resolve until nothing changes.
  // Bounded by the number of tasks: each pass places at least one or stops.
  let pending = [...rows.delegated];
  while (pending.length > 0) {
    const next: AuditLogRow[] = [];
    for (const task of pending) {
      const origin = delegationOriginOf(task);
      const rootId = origin ? rootOfTask.get(origin) : undefined;
      if (rootId) {
        rootOfTask.set(task.id, rootId);
        jobs.get(rootId)!.taskIds.add(task.id);
      } else {
        next.push(task);
      }
    }
    if (next.length === pending.length) break;
    pending = next;
  }

  const invokes = new Map<string, { row: AuditLogRow; rootId: string }>();
  const results = new Map<string, AuditLogRow>();
  for (const row of rows.children) {
    const parent = row.parentEventId;
    if (!parent) continue;
    if (INVOKE_TYPES.has(row.eventType)) {
      const rootId = rootOfTask.get(parent);
      if (rootId) invokes.set(row.id, { row, rootId });
    } else if (RESULT_TYPES.has(row.eventType)) {
      results.set(parent, row);
    } else if (row.eventType === 'agent.response') {
      const rootId = rootOfTask.get(parent);
      if (!rootId) continue;
      const job = jobs.get(rootId)!;
      if (row.timestamp > job.endTs) job.endTs = row.timestamp;
      if (parent === rootId) job.rootResponse = row;
    } else if (row.eventType === 'activity.summary') {
      const job = jobs.get(parent);
      const summary = row.payload.summary;
      if (job && typeof summary === 'string' && summary.trim().length > 0) job.summary = summary.trim();
    }
  }

  for (const [invokeId, { row: invoke, rootId }] of invokes) {
    const result = results.get(invokeId);
    // No result yet: the call is still running (or its result was lost). It
    // has no outcome to report either way.
    if (!result) continue;
    const toolName = readAuditToolName(invoke.payload, {
      action: invoke.action,
      targetType: invoke.targetType,
      targetId: invoke.targetId,
    });
    if (!toolName) continue;
    const ok = readCallOk(result);
    const data = ok ? rec(rec(result.payload.result)?.data) : null;
    const job = jobs.get(rootId)!;
    if (result.timestamp > job.endTs) job.endTs = result.timestamp;
    job.calls.push({
      toolName,
      input: rec(invoke.payload.input) ?? {},
      data,
      ok,
      held: !ok && readCallHeld(result),
      agentId: agentOfTask.get(invoke.parentEventId!) ?? agentOf(job.root),
      taskEventId: invoke.parentEventId!,
      conversationId: invoke.conversationId,
      ts: invoke.timestamp,
    });
  }

  for (const job of jobs.values()) {
    job.calls.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }
  return rows.roots.map((r) => jobs.get(r.id)!);
}

/**
 * Collect what must be resolved before projecting: name references from every
 * call and the job id of every scheduled root.
 */
export function collectActivityRefs(rows: ActivityRows): ActivityRefs {
  const names = new Set<string>();
  const jobIds = new Set<string>();
  for (const job of buildJobs(rows)) {
    for (const call of job.calls) {
      for (const ref of describerRefs(call)) names.add(ref);
    }
    const jobId = parseSchedulerRunJobId(job.root.conversationId ?? undefined);
    if (jobId) jobIds.add(jobId);
  }
  return { names, jobIds };
}

function matchAutonomy(call: Call, autonomyRows: ActionLogRow[]): ActivityAutonomy {
  // action_log.task_id is the agent.task event id, so match on it exactly.
  // Fall back to tool + conversation + time for rows written without it.
  let candidates = autonomyRows.filter((r) => r.toolName === call.toolName && r.taskId === call.taskEventId);
  if (candidates.length === 0) {
    candidates = autonomyRows.filter((r) => {
      if (r.toolName !== call.toolName) return false;
      if (call.conversationId && r.conversationId && r.conversationId !== call.conversationId) return false;
      return Math.abs(r.createdAt.getTime() - call.ts.getTime()) <= AUTONOMY_MATCH_WINDOW_MS;
    });
  }
  if (candidates.some((r) => r.outcome === 'approved')) return 'approved';
  if (candidates.some((r) => r.outcome === 'success')) return 'autonomous';
  return null;
}

/**
 * Fold descriptions into "archived 10 emails, drafted 2 replies". A description
 * without a tally (a rename, a role change) keeps its own text, so no action
 * drops out of the phrase.
 */
function tallyPhrase(descs: ToolDescription[]): string {
  const order: string[] = [];
  const counts = new Map<string, { tally: Tally | null; text: string; count: number }>();
  for (const d of descs) {
    const key = d.tally ? `tally|${d.tally.verb}|${d.tally.many}` : `text|${d.text}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else { counts.set(key, { tally: d.tally ?? null, text: d.text, count: 1 }); order.push(key); }
  }
  return order
    .map((k) => { const e = counts.get(k)!; return e.tally ? formatTally(e.tally, e.count) : e.text; })
    .join(', ');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function researchPhrase(job: Job): string | null {
  let searches = 0;
  let pages = 0;
  for (const call of job.calls) {
    // A search that failed found nothing; it is not research the job did.
    if (!call.ok) continue;
    const kind = researchKind(call.toolName);
    if (kind === 'search') searches += 1;
    else if (kind === 'page') pages += 1;
  }
  if (searches + pages === 0) return null;
  const minutes = Math.max(1, Math.round((job.endTs.getTime() - job.root.timestamp.getTime()) / 60_000));
  const parts = [
    ...(searches > 0 ? [plural(searches, 'search', 'searches')] : []),
    ...(pages > 0 ? [plural(pages, 'page', 'pages')] : []),
  ];
  return `researched for ${minutes} min (${parts.join(', ')})`;
}

/** Generic line for a conversational job with nothing else to show. */
function conversationalFallback(job: Job): string | null {
  const response = job.rootResponse;
  if (!response) return null;
  if (response.payload.isError === true || response.payload.suppressDelivery === true) return null;
  const content = response.payload.content;
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  const channel = job.root.payload.channelId;
  if (typeof channel === 'string' && NON_CONVERSATIONAL_CHANNELS.has(channel)) return null;
  const sender = rec(job.root.payload.senderContext);
  if (sender?.resolved === true && sender.systemRole !== 'principal' && typeof sender.displayName === 'string') {
    return `replied to ${sender.displayName}`;
  }
  return 'answered a question';
}

/** Lookup lines named by tool family, most specific first. */
const LOOKUP_PREFIX_RULES: ReadonlyArray<{ matches: (toolName: string) => boolean; phrase: string }> = [
  { matches: (t) => t.startsWith('ceo-inbox-') || t.startsWith('email-'), phrase: 'checked the inbox' },
  { matches: (t) => t.startsWith('calendar-'), phrase: 'checked the calendar' },
  { matches: (t) => t.startsWith('contact-') || t === 'entity-context', phrase: 'looked up contacts' },
];

/**
 * The lookup line a tool family already gets, or null. The learner skips reads
 * this names: a learned phrase for them would never show.
 */
export function lookupPrefixPhrase(toolName: string): string | null {
  return LOOKUP_PREFIX_RULES.find((rule) => rule.matches(toolName))?.phrase ?? null;
}

/**
 * Line for a job whose only tool work was lookups: nothing changed and no reply
 * went out, but Curia did check something. Named by what it read, never by tool:
 * a known tool family first, then a learned read ("checked the expense sheet").
 */
function lookupFallback(job: Job, catalog: DescriberCatalog): string | null {
  const read = job.calls.filter((c) => c.ok);
  if (read.length === 0) return null;
  for (const rule of LOOKUP_PREFIX_RULES) {
    if (read.some((c) => rule.matches(c.toolName))) return rule.phrase;
  }
  for (const call of read) {
    const learned = catalog.learned(call.agentId, call.toolName);
    if (learned?.effect === 'read') return `${learned.verb} ${learned.one}`;
  }
  return 'looked into a request';
}

/**
 * Description for a call with no code describer (ADR-059). A learned write is a
 * tally; a known write with no row yet is the generic "took an action". Reads,
 * and tools with no row and no signal, stay unnamed, so they are never a hiccup.
 */
function describeUndescribed(call: Call, catalog: DescriberCatalog): ToolDescription | null {
  const learned = catalog.learned(call.agentId, call.toolName);
  if (learned) {
    if (learned.effect !== 'write') return null;
    const tally = { verb: learned.verb, one: learned.one, many: learned.many };
    return {
      prominence: 'count',
      text: call.ok ? formatTally(tally, 1) : notDoneText(learned.attempt, call.held),
      tally,
    };
  }
  if (!catalog.knownWrite(call.toolName)) return null;
  return {
    prominence: 'count',
    text: call.ok ? formatTally(GENERIC_ACTION_TALLY, 1) : notDoneText(GENERIC_ACTION_ATTEMPT, call.held),
    tally: GENERIC_ACTION_TALLY,
  };
}

function linkFor(job: Job, jobId: string | undefined): ActivityLink | null {
  if (jobId) return { kind: 'job', jobId };
  const conversationId = job.root.conversationId;
  if (!conversationId) return null;
  return {
    kind: 'conversation',
    conversationId,
    from: new Date(job.root.timestamp.getTime() - LINK_PAD_MS).toISOString(),
    to: new Date(job.endTs.getTime() + LINK_PAD_MS).toISOString(),
  };
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function projectJob(job: Job, ctx: ProjectionContext): ActivityItem | null {
  const lines: ToolDescription[] = [];
  const counts: ToolDescription[] = [];
  const failures: ToolDescription[] = [];
  // Calls a policy guard held or refused by design (#2587). Shown like a failure's line,
  // after the failures, but they never make the job partial or failed.
  const holds: ToolDescription[] = [];
  const autonomy: ActivityAutonomy[] = [];
  const catalog = ctx.catalog ?? EMPTY_CATALOG;

  for (const call of job.calls) {
    const desc = describeToolCall(call, ctx) ?? describeUndescribed(call, catalog);
    if (!desc || desc.prominence === 'hidden') continue;
    if (!call.ok && call.held === true) holds.push(desc);
    else if (!call.ok) failures.push(desc);
    else if (desc.prominence === 'line') lines.push(desc);
    else counts.push(desc);
    autonomy.push(matchAutonomy(call, ctx.autonomyRows));
  }

  const research = researchPhrase(job);
  const responseFailed = job.rootResponse?.payload.isError === true;
  // Everything that did not happen, failures first. The text uses it; the outcome uses failures only.
  const failureTexts = [...failures, ...holds].map((f) => f.text);
  const jobId = parseSchedulerRunJobId(job.root.conversationId ?? undefined);

  let headline: string | null;
  let details: string[];

  if (jobId) {
    // Scheduled job: its name plus what it did, every action folded into counts.
    const label = ctx.jobLabel(jobId);
    const done = tallyPhrase([...lines, ...counts]) || research || job.summary || null;
    const outcomeText = done ?? (failureTexts.length > 0 || responseFailed ? null : 'no action needed');
    headline = label
      ? (outcomeText ? `${label}: ${outcomeText}` : label)
      : (outcomeText ? `ran a scheduled job: ${outcomeText}` : 'ran a scheduled job');
    details = [...lines.map((l) => l.text), ...failureTexts];
    if (research && done !== research) details.push(research);
  } else if (lines.length === 1) {
    headline = lines[0]!.text;
    const countText = tallyPhrase(counts);
    details = [...(countText ? [countText] : []), ...failureTexts, ...(research ? [research] : [])];
  } else if (lines.length > 1) {
    headline = tallyPhrase([...lines, ...counts]);
    details = [...lines.map((l) => l.text), ...failureTexts, ...(research ? [research] : [])];
  } else if (counts.length > 0) {
    headline = tallyPhrase(counts);
    details = [...failureTexts, ...(research ? [research] : [])];
  } else if (failureTexts.length > 0) {
    headline = failureTexts[0]!;
    details = [...failureTexts.slice(1), ...(research ? [research] : [])];
  } else if (research) {
    headline = research;
    details = [];
  } else if (job.summary) {
    headline = job.summary;
    details = [];
  } else if (responseFailed) {
    headline = 'ran into an error';
    details = [];
  } else {
    headline = conversationalFallback(job) ?? lookupFallback(job, catalog);
    details = [];
  }

  if (!headline) return null;

  const succeeded = lines.length + counts.length;
  let outcome: ActivityOutcome = 'success';
  if (failures.length > 0) outcome = succeeded > 0 ? 'partial' : 'failed';
  else if (responseFailed) outcome = succeeded > 0 ? 'partial' : 'failed';

  const itemAutonomy: ActivityAutonomy = autonomy.includes('approved')
    ? 'approved'
    : autonomy.includes('autonomous') ? 'autonomous' : null;

  const actor = typeof job.root.payload.agentId === 'string' ? job.root.payload.agentId : job.root.sourceId;

  return {
    id: job.root.id,
    ts: job.root.timestamp.toISOString(),
    actor,
    headline: jobId ? headline : lowerFirst(headline),
    details,
    outcome,
    autonomy: itemAutonomy,
    link: linkFor(job, jobId),
  };
}

/**
 * Project the rows into activity items, newest first. Jobs with nothing to
 * show (plumbing only, no reply) are dropped, so the result can be shorter
 * than `rows.roots`.
 */
export function projectActivity(rows: ActivityRows, ctx: ProjectionContext): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const job of buildJobs(rows)) {
    const item = projectJob(job, ctx);
    if (item) items.push(item);
  }
  return items;
}
