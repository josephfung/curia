import { CronExpressionParser } from 'cron-parser';
import { toLocalIso } from '../../src/time/timestamp.js';

// tests/shared/tool-state.ts — per-case memory of stubbed writes (#2074).
//
// Smoke and the scenario suite both answer scheduler, task and draft reads from
// fixtures. A later read in the same case should show what those writes did, the
// way the real store would. Each case attempt (each scenario run) owns one
// CaseToolState; clear() / endRun() drops it, so concurrent cases stay apart.
//
// The matched stub is the base. A row it already lists keeps the stub's fields,
// and later edits overlay them. Query filters (status, agent, owner, tag) apply
// whenever the call passes them, whether or not the case has written yet.

type Json = Record<string, unknown>;

/**
 * The calendar writes one case has made (stubbed), replayed onto its later
 * calendar-list-events results. Created events get distinct ids, so two creates in a case
 * don't collide.
 */
export class CalendarState {
  private created: Json[] = [];
  private updates = new Map<string, Json>();
  private deleted = new Set<string>();

  /** Record a stubbed write; returns the result to hand back (a created event gets its id). */
  recordWrite(toolName: string, data: Json, input: Json): Json {
    if (toolName === 'calendar-create-event' && data['event'] && typeof data['event'] === 'object') {
      const event = { ...(data['event'] as Json), id: `evt-created-${this.created.length + 1}` };
      this.created.push(event);
      return { ...data, event };
    }
    if (toolName === 'calendar-update-event' && typeof input['eventId'] === 'string') {
      // Only the fields the call set; the rest of the event stays as listed.
      const changes: Json = {};
      if (input['title'] !== undefined) changes['title'] = input['title'];
      if (input['start'] !== undefined) changes['startTime'] = input['start'];
      if (input['end'] !== undefined) changes['endTime'] = input['end'];
      if (input['location'] !== undefined) changes['location'] = input['location'];
      this.updates.set(input['eventId'], { ...(this.updates.get(input['eventId']) ?? {}), ...changes });
    }
    if (toolName === 'calendar-delete-event' && typeof input['eventId'] === 'string') {
      this.deleted.add(input['eventId']);
    }
    return data;
  }

  /** A listing as it stands after this case's writes. */
  replayOnto(data: Json): Json {
    if (!Array.isArray(data['events'])) return data;
    const events = [...(data['events'] as Json[]), ...this.created]
      .filter(e => !this.deleted.has(String(e['id'])))
      .map(e => ({ ...e, ...(this.updates.get(String(e['id'])) ?? {}) }));
    return { ...data, events };
  }
}

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
}

/**
 * Next fire of a cron expression, in the job's zone. Same call as
 * `SchedulerService.nextRunFromCron`. A bad expression or zone returns undefined
 * so a fixture cannot take the case down.
 */
function nextFire(cronExpr: string, timezone: string): Date | undefined {
  try {
    return CronExpressionParser.parse(cronExpr, { tz: timezone }).next().toDate();
  } catch {
    return undefined;
  }
}

/** Local ISO, as `scheduler-list` returns it (`toLocalIso`), not a UTC Z string. */
function formatNextRun(instant: Date, timezone: string): string | null {
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return toLocalIso(Math.floor(instant.getTime() / 1000), timezone);
  } catch {
    return null;
  }
}

/** Cron wins on create, matching `createJob`. An edit that sets `run_at` is handled by the caller. */
function scheduledNextRun(cronExpr: string | null, runAt: string | null, timezone: string): string | null {
  if (cronExpr) {
    const instant = nextFire(cronExpr, timezone);
    return instant ? formatNextRun(instant, timezone) : null;
  }
  if (!runAt) return null;
  return formatNextRun(new Date(runAt), timezone);
}

const TASK_PREVIEW_CHARS = 160;

/** Same preview scheduler-list builds: collapsed whitespace, cut at 160 characters. */
function taskPreview(task: string): string {
  const flat = task.trim().replace(/\s+/g, ' ');
  return flat.length > TASK_PREVIEW_CHARS ? `${flat.slice(0, TASK_PREVIEW_CHARS)}…` : flat;
}

/** A participant's address, lowercased: how drafts compare recipients. */
function participantKey(participant: Json): string {
  return String(participant['email']).trim().toLowerCase();
}

/** Participants with repeats (by address) removed; the first one wins. */
function uniqueByKey(participants: Json[]): Json[] {
  const seen = new Set<string>();
  return participants.filter((p) => {
    const key = participantKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function asParticipants(value: unknown): Json[] {
  if (typeof value === 'string') {
    const email = value.trim();
    return email ? [{ email }] : [];
  }
  if (!Array.isArray(value)) return [];
  const out: Json[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const email = item.trim();
      if (email) out.push({ email });
    } else if (isRecord(item) && typeof item['email'] === 'string') {
      out.push(item);
    }
  }
  return out;
}

/**
 * Listed rows are the base. A created row is added only when that id is not already
 * listed; when it is, the listed fields win over the create, so a turn stub can script
 * a world that disagrees with an earlier write. `updates` then overlay both. Newest
 * create first. Rows with no id are returned as `extras` and kept on an unfiltered list.
 */
function mergeRows(
  listed: readonly unknown[],
  idKey: string,
  created: readonly Json[],
  updates: ReadonlyMap<string, Json>,
): { rows: Json[]; extras: unknown[] } {
  const extras: unknown[] = [];
  const stubById = new Map<string, Json>();
  const stubOrder: string[] = [];
  for (const row of listed) {
    if (!isRecord(row)) { extras.push(row); continue; }
    const id = row[idKey];
    if (typeof id !== 'string' || id === '') { extras.push(row); continue; }
    if (!stubById.has(id)) stubOrder.push(id);
    stubById.set(id, row);
  }
  const seen = new Set<string>();
  const rows: Json[] = [];
  const push = (id: string, base: Json): void => {
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ ...base, ...(updates.get(id) ?? {}) });
  };
  for (const row of [...created].reverse()) {
    const id = row[idKey];
    if (typeof id !== 'string' || id === '') continue;
    const stub = stubById.get(id);
    push(id, stub ? { ...row, ...stub } : { ...row });
  }
  for (const id of stubOrder) {
    const stub = stubById.get(id);
    if (stub) push(id, { ...stub });
  }
  return { rows, extras };
}

/** The stub's id when it is new; otherwise the next minted one, so two creates don't collapse. */
function freshId(preferred: string | undefined, taken: ReadonlySet<string>, prefix: string, n: number): string {
  if (preferred && !taken.has(preferred)) return preferred;
  let i = n;
  let id = `${prefix}-${i}`;
  while (taken.has(id)) {
    i += 1;
    id = `${prefix}-${i}`;
  }
  return id;
}

/**
 * Scheduler writes one case has made, replayed onto later scheduler-list results.
 * A cancel sets status to `cancelled` (the real tool soft-deletes; an unfiltered list
 * still returns the row). The first create keeps the id the stub returned, so a later
 * turn can list that same id; a repeated id is minted a new one.
 */
export class SchedulerState {
  private created: Json[] = [];
  private updates = new Map<string, Json>();

  private dirty(): boolean {
    return this.created.length > 0 || this.updates.size > 0;
  }

  recordWrite(toolName: string, data: Json, input: Json): Json {
    if (toolName === 'scheduler-create') return this.recordCreate(data, input);
    if (toolName === 'scheduler-update') return this.recordUpdate(data, input);
    if (toolName === 'scheduler-cancel') return this.recordCancel(data, input);
    return data;
  }

  private recordCreate(data: Json, input: Json): Json {
    const taken = new Set(this.created.map(job => String(job['id'])));
    const id = freshId(str(data['jobId']), taken, 'job-created', this.created.length + 1);
    const task = typeof input['task'] === 'string' ? input['task'] : undefined;
    const cronExpr = str(input['cron_expr']) ?? null;
    const runAt = str(input['run_at']) ?? null;
    const timezone = str(input['timezone']) ?? null;
    // A job with no zone is interpreted in UTC for the next-run math. The real
    // service uses its configured zone; the stub does not have that.
    this.created.push({
      id,
      agentId: str(input['agent_id']) ?? 'coordinator',
      status: 'pending',
      cronExpr,
      runAt,
      nextRunAt: scheduledNextRun(cronExpr, runAt, timezone ?? 'UTC'),
      lastRunAt: null,
      lastRunOutcome: null,
      consecutiveFailures: 0,
      lastError: null,
      timezone,
      taskTitle: null,
      taskPreview: task !== undefined ? taskPreview(task) : null,
      intentAnchor: str(input['intent_anchor']) ?? null,
      taskTags: null,
      agentTaskId: null,
      createdBy: str(input['agent_id']) ?? 'coordinator',
      createdAt: null,
    });
    return { ...data, jobId: id };
  }

  private recordUpdate(data: Json, input: Json): Json {
    const id = str(input['job_id']);
    if (!id) return data;
    const changes: Json = {};
    const action = input['action'];
    if (action === 'pause') changes['status'] = 'paused';
    else if (action === 'resume') changes['status'] = 'pending';
    else if (action === 'edit') {
      const cron = str(input['cron_expr']);
      if (cron) changes['cronExpr'] = cron;
      const runAt = str(input['run_at']);
      if (runAt) changes['runAt'] = runAt;
      const payload = input['task_payload'];
      if (isRecord(payload) && typeof payload['task'] === 'string') changes['taskPreview'] = taskPreview(payload['task']);
    }
    if (Object.keys(changes).length === 0) return data;
    this.updates.set(id, { ...(this.updates.get(id) ?? {}), ...changes });
    return data;
  }

  private recordCancel(data: Json, input: Json): Json {
    const id = str(input['job_id']);
    if (!id) return data;
    this.updates.set(id, { ...(this.updates.get(id) ?? {}), status: 'cancelled' });
    return data;
  }

  /**
   * A listing as it stands after this case's writes. Status and agent filters apply
   * whenever the call passes them, so the same arguments don't change meaning after
   * an unrelated write. `dirty()` only decides whether to merge writes in.
   *
   * `nextRunAt` is refreshed after the merge, once the row's timezone is known.
   * An edit that sets `cron_expr` or `run_at` replaces it (a `run_at` edit wins,
   * as in `updateJob`). A row the stub left without one is filled from its cron
   * or `run_at`, so a weekday job is not stuck on a date a placeholder invented.
   */
  replayOnto(data: Json, input: Json): Json {
    const listed = data['jobs'];
    if (!Array.isArray(listed)) return data;
    const filtering = input['status'] !== undefined || input['agent_id'] !== undefined;
    const limitAsked = typeof input['limit'] === 'number';

    let jobs: unknown[];
    if (this.dirty()) {
      const { rows, extras } = mergeRows(listed, 'id', this.created, this.updates);
      jobs = filtering ? rows : [...rows, ...extras];
    } else {
      jobs = [...listed];
    }
    const pinned = pinnedNextRuns(listed);
    jobs = jobs.map(job => this.refreshNextRun(job, pinned));
    if (!this.dirty() && !filtering && !limitAsked) {
      if (jobs.every((job, i) => job === listed[i])) return data;
      return { ...data, jobs };
    }
    if (typeof input['status'] === 'string') jobs = jobs.filter(job => isRecord(job) && job['status'] === input['status']);
    if (typeof input['agent_id'] === 'string') jobs = jobs.filter(job => isRecord(job) && job['agentId'] === input['agent_id']);
    if (!this.dirty() && !limitAsked) return { ...data, jobs, count: jobs.length };

    const limit = clampLimit(input['limit'], typeof data['limit'] === 'number' ? data['limit'] : 50, 200);
    const truncated = jobs.length > limit;
    const page = jobs.slice(0, limit);
    return { ...data, jobs: page, count: page.length, truncated, limit };
  }

  /**
   * Next run for one merged row. A schedule edit replaces a pinned value. A row
   * the stub left blank is filled from the merged cron, which may be the turn
   * stub's rather than the create's.
   */
  private refreshNextRun(job: unknown, pinned: ReadonlySet<string>): unknown {
    if (!isRecord(job)) return job;
    const id = typeof job['id'] === 'string' ? job['id'] : undefined;
    const update = id !== undefined ? this.updates.get(id) : undefined;
    const tz = typeof job['timezone'] === 'string' && job['timezone'] !== '' ? job['timezone'] : 'UTC';
    const runAtEdit = update !== undefined ? str(update['runAt']) : undefined;
    const cronEdit = update !== undefined && typeof update['cronExpr'] === 'string';
    if (!runAtEdit && !cronEdit && id !== undefined && pinned.has(id)) return job;

    const cron = typeof job['cronExpr'] === 'string' ? job['cronExpr'] : undefined;
    const runAt = typeof job['runAt'] === 'string' ? job['runAt'] : undefined;
    let formatted: string | null = null;
    if (runAtEdit !== undefined) formatted = formatNextRun(new Date(runAtEdit), tz);
    else if (cron) formatted = scheduledNextRun(cron, null, tz);
    else if (runAt) formatted = formatNextRun(new Date(runAt), tz);
    if (!formatted || formatted === job['nextRunAt']) return job;
    return { ...job, nextRunAt: formatted };
  }
}

/** Ids whose stub row already names a next run. An edit still replaces that value. */
function pinnedNextRuns(listed: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const row of listed) {
    if (!isRecord(row) || typeof row['id'] !== 'string') continue;
    if (row['nextRunAt'] !== undefined && row['nextRunAt'] !== null) ids.add(row['id']);
  }
  return ids;
}

interface DraftRecord {
  id: string;
  subject: string;
  to: unknown;
  cc: unknown;
  body: string;
}

/**
 * Mailbox drafts one case has created or edited. `ceo-inbox-read` of a recorded
 * `draft_id` returns the draft, so the read does not fall through to Nylas.
 * `ceo-inbox-shadow-draft` is a working-doc capture, not a mailbox draft, so it
 * is not recorded here.
 */
export class DraftState {
  private drafts = new Map<string, DraftRecord>();

  recordWrite(toolName: string, data: Json, input: Json): Json {
    if (toolName === 'ceo-inbox-draft-edit') return this.recordEdit(data, input);
    if (toolName === 'ceo-inbox-draft-compose' || toolName === 'ceo-inbox-draft-reply') {
      return this.recordDraft(data, input);
    }
    return data;
  }

  private recordDraft(data: Json, input: Json): Json {
    // Keep the stub's id. Office edit stubs match only draft-0001 and draft-0002,
    // so minting a fresh one would make the following edit miss.
    const id = str(data['draft_id']);
    if (!id) return data;
    const prev = this.drafts.get(id);
    // Returned fields win, then the call's arguments, then whatever this id already held.
    // A compose names recipients by contact ID (to, cc) and by address (to_addresses,
    // cc_addresses), so the draft holds both, as written (#2053).
    let to: unknown = prev?.to ?? [];
    if (input['recipients'] !== undefined) to = input['recipients'];
    if (input['to'] !== undefined || input['to_addresses'] !== undefined) {
      to = [...asParticipants(input['to']), ...asParticipants(input['to_addresses'])];
    }
    if (data['to'] !== undefined) to = data['to'];
    let cc: unknown = prev?.cc ?? [];
    if (input['cc'] !== undefined || input['cc_addresses'] !== undefined) {
      cc = [...asParticipants(input['cc']), ...asParticipants(input['cc_addresses'])];
    }
    if (data['cc'] !== undefined) cc = data['cc'];
    const subject = typeof data['subject'] === 'string' ? data['subject']
      : typeof input['subject'] === 'string' ? input['subject']
        : prev?.subject ?? '';
    const body = typeof input['body'] === 'string' ? input['body'] : prev?.body ?? '';
    this.drafts.set(id, { id, subject, to, cc, body });
    return data;
  }

  private recordEdit(data: Json, input: Json): Json {
    const id = str(input['draft_id']) ?? str(data['draft_id']);
    if (!id) return data;
    // An edit of an id this case never wrote must not invent a draft. The office
    // edit stub accepts draft-0001 and draft-0002 either way; a guessed id used to
    // come back from ceo-inbox-read with an empty subject and no recipients.
    const prev = this.drafts.get(id);
    if (!prev) return data;
    const next: DraftRecord = { ...prev, id };
    if (typeof input['subject'] === 'string') next.subject = input['subject'];
    if (typeof input['body'] === 'string') next.body = input['body'];
    // Recipients change one at a time (#2053): remove takes entries off both lines, and
    // an addition goes on its line and off the other. Entries are compared as written.
    const removed = new Set(asParticipants(input['remove']).map(participantKey));
    const addTo = [...asParticipants(input['add_to']), ...asParticipants(input['add_to_addresses'])];
    const addCc = [...asParticipants(input['add_cc']), ...asParticipants(input['add_cc_addresses'])];
    if (removed.size > 0 || addTo.length > 0 || addCc.length > 0) {
      const addToKeys = new Set(addTo.map(participantKey));
      const addCcKeys = new Set(addCc.map(participantKey));
      const keep = (list: unknown, other: ReadonlySet<string>): Json[] =>
        asParticipants(list).filter((p) => !removed.has(participantKey(p)) && !other.has(participantKey(p)));
      const to = uniqueByKey([...keep(prev.to, addCcKeys), ...addTo]);
      const toKeys = new Set(to.map(participantKey));
      next.to = to;
      // Someone on the To line is not repeated on Cc, as in the real tool.
      next.cc = uniqueByKey([...keep(prev.cc, addToKeys), ...addCc]).filter((p) => !toKeys.has(participantKey(p)));
    }
    this.drafts.set(id, next);
    return data;
  }

  /** The draft read, or undefined when this call is not a recorded draft. */
  read(input: Json): Json | undefined {
    const draftId = str(input['draft_id']);
    // The real tool rejects a call that passes both ids. Leave that to the stub.
    if (!draftId || str(input['message_id'])) return undefined;
    const draft = this.drafts.get(draftId);
    if (!draft) return undefined;
    return {
      id: draft.id,
      threadId: '',
      to: asParticipants(draft.to),
      cc: asParticipants(draft.cc),
      bcc: [],
      subject: draft.subject,
      body_plain: draft.body,
      body_html: draft.body,
      date: 0,
      is_draft: true,
    };
  }
}

/**
 * Task writes one case has made, replayed onto later task-list results.
 * Completion sets status to `done`, so a list filtered to open tasks omits it.
 */
export class TaskState {
  private created: Json[] = [];
  private updates = new Map<string, Json>();

  private dirty(): boolean {
    return this.created.length > 0 || this.updates.size > 0;
  }

  recordWrite(toolName: string, data: Json, input: Json): Json {
    if (toolName === 'task-create') return this.recordCreate(data, input);
    if (toolName === 'task-update') return this.recordUpdate(data, input);
    if (toolName === 'task-complete') return this.recordComplete(data, input);
    return data;
  }

  private recordCreate(data: Json, input: Json): Json {
    const taken = new Set(this.created.map(task => String(task['task_id'])));
    const id = freshId(str(data['task_id']), taken, 'task-created', this.created.length + 1);
    this.created.push({
      task_id: id,
      title: typeof data['title'] === 'string' ? data['title'] : typeof input['title'] === 'string' ? input['title'] : '',
      status: typeof data['status'] === 'string' ? data['status'] : 'open',
      owner: typeof data['owner'] === 'string' ? data['owner'] : str(input['owner']) ?? 'curia',
      priority: typeof data['priority'] === 'number' ? data['priority'] : typeof input['priority'] === 'number' ? input['priority'] : 3,
      due_at: typeof input['due_at'] === 'string' ? input['due_at'] : null,
      tags: Array.isArray(data['tags']) ? data['tags'] : Array.isArray(input['tags']) ? input['tags'] : [],
      age: 'today',
      last_progress_note: typeof input['progress_note'] === 'string' ? input['progress_note'] : null,
      next_wake_at: typeof input['wake_at'] === 'string' ? input['wake_at'] : null,
      source_agent_id: null,
      blocked_by_task_id: typeof input['blocked_by_task_id'] === 'string' ? input['blocked_by_task_id'] : null,
      parent_task_id: typeof input['parent_task_id'] === 'string' ? input['parent_task_id'] : null,
    });
    return { ...data, task_id: id };
  }

  private recordUpdate(data: Json, input: Json): Json {
    const id = str(input['task_id']);
    if (!id) return data;
    const changes: Json = {};
    if (typeof input['status'] === 'string') changes['status'] = input['status'];
    if (typeof input['priority'] === 'number') changes['priority'] = input['priority'];
    if (typeof input['owner'] === 'string') changes['owner'] = input['owner'];
    if (typeof input['due_at'] === 'string') changes['due_at'] = input['due_at'];
    if (Array.isArray(input['tags'])) changes['tags'] = input['tags'];
    if (input['blocked_by_task_id'] !== undefined) changes['blocked_by_task_id'] = input['blocked_by_task_id'];
    if (typeof input['progress_note'] === 'string') changes['last_progress_note'] = input['progress_note'];
    if (typeof input['wake_at'] === 'string') changes['next_wake_at'] = input['wake_at'];
    if (Object.keys(changes).length === 0) return data;
    this.updates.set(id, { ...(this.updates.get(id) ?? {}), ...changes });
    return data;
  }

  private recordComplete(data: Json, input: Json): Json {
    const id = str(input['task_id']);
    if (!id) return data;
    this.updates.set(id, { ...(this.updates.get(id) ?? {}), status: 'done' });
    return data;
  }

  replayOnto(data: Json, input: Json): Json {
    const listed = data['tasks'];
    if (!Array.isArray(listed)) return data;
    const filtering = input['status'] !== undefined || input['owner'] !== undefined
      || input['tag'] !== undefined || input['parent_task_id'] !== undefined || input['due_before'] !== undefined;
    const limitAsked = typeof input['limit'] === 'number';
    if (!this.dirty() && !filtering && !limitAsked) return data;

    let tasks: unknown[];
    if (this.dirty()) {
      const { rows, extras } = mergeRows(listed, 'task_id', this.created, this.updates);
      tasks = filtering ? [...rows] : [...rows, ...extras];
    } else {
      tasks = [...listed];
    }
    if (typeof input['status'] === 'string') {
      const wanted = new Set(input['status'].split(',').map(part => part.trim()).filter(Boolean));
      tasks = tasks.filter(task => isRecord(task) && typeof task['status'] === 'string' && wanted.has(task['status']));
    }
    if (typeof input['owner'] === 'string') tasks = tasks.filter(task => isRecord(task) && task['owner'] === input['owner']);
    if (typeof input['tag'] === 'string') {
      tasks = tasks.filter(task => isRecord(task) && Array.isArray(task['tags']) && task['tags'].includes(input['tag']));
    }
    if (typeof input['parent_task_id'] === 'string') {
      tasks = tasks.filter(task => isRecord(task) && task['parent_task_id'] === input['parent_task_id']);
    }
    if (typeof input['due_before'] === 'string') {
      const cutoff = Date.parse(input['due_before']);
      if (!Number.isNaN(cutoff)) {
        tasks = tasks.filter(task => {
          if (!isRecord(task) || typeof task['due_at'] !== 'string') return false;
          const due = Date.parse(task['due_at']);
          return !Number.isNaN(due) && due < cutoff;
        });
      }
    }
    if (!this.dirty() && !limitAsked) return { ...data, tasks, count: tasks.length };
    const limit = clampLimit(input['limit'], 25, 100);
    const page = tasks.slice(0, limit);
    return { ...data, tasks: page, count: page.length };
  }
}

/** Per-case write memory for every tool family whose reads should reflect its writes. */
export class CaseToolState {
  readonly calendar = new CalendarState();
  readonly scheduler = new SchedulerState();
  readonly drafts = new DraftState();
  readonly tasks = new TaskState();
}

const SCHEDULER_WRITES: ReadonlySet<string> = new Set(['scheduler-create', 'scheduler-update', 'scheduler-cancel']);
const DRAFT_WRITES: ReadonlySet<string> = new Set([
  'ceo-inbox-draft-compose', 'ceo-inbox-draft-reply', 'ceo-inbox-draft-edit',
]);
const TASK_WRITES: ReadonlySet<string> = new Set(['task-create', 'task-update', 'task-complete']);

/**
 * Record a stubbed scheduler, draft or task write and replay it onto a later list.
 * Placeholders and the calendar/mail query filters stay in `shapeStubResult`: the
 * scenario layer calls this on data that is already resolved.
 */
export function applyCaseWrites(toolName: string, data: Json, input: Json, state: CaseToolState): Json {
  let shaped = data;
  if (SCHEDULER_WRITES.has(toolName)) shaped = state.scheduler.recordWrite(toolName, shaped, input);
  if (DRAFT_WRITES.has(toolName)) shaped = state.drafts.recordWrite(toolName, shaped, input);
  if (TASK_WRITES.has(toolName)) shaped = state.tasks.recordWrite(toolName, shaped, input);
  if (toolName === 'scheduler-list') shaped = state.scheduler.replayOnto(shaped, input);
  if (toolName === 'task-list') shaped = state.tasks.replayOnto(shaped, input);
  return shaped;
}

/**
 * A `ceo-inbox-read` of a draft this case already wrote, or undefined.
 * A stub whose match names `draft_id` is scripting that read, so it wins.
 */
export function recordedDraftRead(
  toolName: string,
  input: Json,
  state: CaseToolState,
  stubMatch: Record<string, unknown> | undefined,
): Json | undefined {
  if (toolName !== 'ceo-inbox-read') return undefined;
  if (stubMatch !== undefined && Object.hasOwn(stubMatch, 'draft_id')) return undefined;
  return state.drafts.read(input);
}
