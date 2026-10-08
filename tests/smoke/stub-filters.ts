// tests/smoke/stub-filters.ts — make list/search stubs answer the question asked (#1956).
//
// A stub returns the same fixture whatever the arguments, but calendar and mailbox reads
// are queries: "Wednesday's events", "mail from Priya". Returning the whole fixture would
// hand the model events outside its window or messages that don't match its search —
// something the real tools never do. These filters narrow a stubbed result by the call's
// arguments, the way the real tool would, so one shared fixture serves every query.
//
// They also fill `{{input:<arg>}}` in a stubbed result with the call's own argument, so a
// stubbed write (calendar-create-event, task-create) echoes back what was asked for.
// SmokeToolState remembers a case's writes and replays them onto later reads: the
// calendar specialist re-reads the day, the coordinator re-lists a job it just edited,
// and a draft read-back would otherwise hit the real tool and fail closed in test mode.

type Json = Record<string, unknown>;

const INPUT_PLACEHOLDER = /\{\{\s*input:([A-Za-z0-9_]+)\s*\}\}/g;
const WHOLE_INPUT_PLACEHOLDER = /^\{\{\s*input:([A-Za-z0-9_]+)\s*\}\}$/;

/**
 * Replace `{{input:<arg>}}` with the call's argument. A string that is only the
 * placeholder takes the argument's value as-is (any type; null when absent); one
 * embedded in other text gets it as a string.
 */
export function fillInputPlaceholders(value: unknown, input: Json): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE_INPUT_PLACEHOLDER.exec(value);
    if (whole) return input[whole[1]!] ?? null;
    return value.replace(INPUT_PLACEHOLDER, (_, key: string) => {
      const v = input[key];
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => fillInputPlaceholders(v, input));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillInputPlaceholders(v, input)]));
  }
  return value;
}

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  return (typeof v === 'string' ? v : JSON.stringify(v)).toLowerCase();
}

function time(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** calendar-list-events: events overlapping [timeMin, timeMax), matching query and attendee. */
function filterEvents(data: Json, input: Json): Json {
  if (!Array.isArray(data['events'])) return data;
  const min = time(input['timeMin']);
  const max = time(input['timeMax']);
  const query = typeof input['query'] === 'string' ? input['query'].toLowerCase() : '';
  const attendee = typeof input['attendeeEmail'] === 'string' ? input['attendeeEmail'].toLowerCase() : '';
  const events = (data['events'] as Json[]).filter((e) => {
    const start = time(e['startTime']);
    const end = time(e['endTime']) ?? start;
    if (min !== undefined && end !== undefined && end <= min) return false;
    if (max !== undefined && start !== undefined && start >= max) return false;
    if (query && !`${text(e['title'])} ${text(e['description'])} ${text(e['location'])}`.includes(query)) return false;
    if (attendee && !text(e['participants']).includes(attendee)) return false;
    return true;
  });
  const limit = typeof input['maxResults'] === 'number' ? input['maxResults'] : undefined;
  const kept = limit !== undefined ? events.slice(0, limit) : events;
  return { ...data, events: kept, count: kept.length };
}

/** calendar-find-free-time: windows inside [timeMin, timeMax), and at least `duration` minutes long. */
function filterFreeWindows(data: Json, input: Json): Json {
  if (!Array.isArray(data['freeWindows'])) return data;
  const min = time(input['timeMin']);
  const max = time(input['timeMax']);
  const minutes = typeof input['duration'] === 'number' ? input['duration'] : 0;
  const windows = (data['freeWindows'] as Json[]).filter((w) => {
    const start = time(w['start']);
    const end = time(w['end']);
    if (start === undefined || end === undefined) return true;
    if (min !== undefined && end <= min) return false;
    if (max !== undefined && start >= max) return false;
    return end - start >= minutes * 60_000;
  });
  return { ...data, freeWindows: windows };
}

/**
 * Gmail-style query, loosely. Terms are ANDed; `a OR b` matches either (OR binds the terms
 * either side of it); `-term` excludes; parentheses are ignored. `field:value` terms (from,
 * to, subject) match that field, bare words the sender, subject or snippet. Operators this
 * fixture cannot evaluate (is:, has:, in:, label:, category:, newer_than:…) are ignored —
 * including when negated — rather than matching nothing, so a real specialist query never
 * finds an empty fixture inbox for the wrong reason.
 */
export function matchesMailQuery(message: Json, query: string): boolean {
  const tokens = (query.replace(/[()]/g, ' ').match(/-?(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) ?? []);
  // Group into AND-ed clauses, each a list of OR-ed alternatives.
  const clauses: string[][] = [];
  let joinNext = false;
  for (const raw of tokens) {
    if (raw === 'OR' || raw === '|') { joinNext = clauses.length > 0; continue; }
    if (raw.toUpperCase() === 'AND') continue;
    if (joinNext) clauses[clauses.length - 1]!.push(raw);
    else clauses.push([raw]);
    joinNext = false;
  }
  return clauses.every(alternatives => alternatives.some(term => termMatches(message, term)));
}

function termMatches(message: Json, raw: string): boolean {
  const negated = raw.startsWith('-') && raw.length > 1;
  const term = (negated ? raw.slice(1) : raw).toLowerCase();
  const field = /^(\w+):(.*)$/.exec(term);
  let hit: boolean;
  if (field) {
    const value = field[2]!.replace(/^"|"$/g, '');
    if (field[1] === 'from') hit = text(message['from']).includes(value);
    else if (field[1] === 'to') hit = text(message['to']).includes(value);
    else if (field[1] === 'subject') hit = text(message['subject']).includes(value);
    else return true; // an operator the fixture can't evaluate: ignore it either way
  } else {
    const word = term.replace(/^"|"$/g, '');
    hit = `${text(message['from'])} ${text(message['subject'])} ${text(message['snippet'])}`.includes(word);
  }
  return negated ? !hit : hit;
}

/** ceo-inbox-list / ceo-inbox-search: unread and query filters, then the limit. */
function filterMail(data: Json, input: Json, search: boolean): Json {
  if (!Array.isArray(data['messages'])) return data;
  let messages = data['messages'] as Json[];
  if (!search && input['unread_only'] !== false) messages = messages.filter(m => m['unread'] !== false);
  if (search && typeof input['query'] === 'string') messages = messages.filter(m => matchesMailQuery(m, input['query'] as string));
  const limit = typeof input['limit'] === 'number' ? input['limit'] : search ? 10 : 20;
  const kept = messages.slice(0, limit);
  return {
    ...data,
    messages: kept,
    count: kept.length,
    ...(search ? {} : { has_more: messages.length > kept.length }),
  };
}

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

const TASK_PREVIEW_CHARS = 160;

/** Same preview scheduler-list builds: collapsed whitespace, cut at 160 characters. */
function taskPreview(task: string): string {
  const flat = task.trim().replace(/\s+/g, ' ');
  return flat.length > TASK_PREVIEW_CHARS ? `${flat.slice(0, TASK_PREVIEW_CHARS)}…` : flat;
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
    this.created.push({
      id,
      agentId: str(input['agent_id']) ?? 'coordinator',
      status: 'pending',
      cronExpr: str(input['cron_expr']) ?? null,
      runAt: str(input['run_at']) ?? null,
      nextRunAt: null,
      lastRunAt: null,
      lastRunOutcome: null,
      consecutiveFailures: 0,
      lastError: null,
      timezone: str(input['timezone']) ?? null,
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

  /** A listing as it stands after this case's writes. Untouched listings pass through. */
  replayOnto(data: Json, input: Json): Json {
    if (!this.dirty()) return data;
    const listed = data['jobs'];
    if (!Array.isArray(listed)) return data;
    const { rows, extras } = mergeRows(listed, 'id', this.created, this.updates);
    const narrowing = input['status'] !== undefined || input['agent_id'] !== undefined;
    let jobs: unknown[] = narrowing ? rows : [...rows, ...extras];
    if (typeof input['status'] === 'string') jobs = jobs.filter(job => isRecord(job) && job['status'] === input['status']);
    if (typeof input['agent_id'] === 'string') jobs = jobs.filter(job => isRecord(job) && job['agentId'] === input['agent_id']);
    const limit = clampLimit(input['limit'], typeof data['limit'] === 'number' ? data['limit'] : 50, 200);
    const truncated = jobs.length > limit;
    const page = jobs.slice(0, limit);
    return { ...data, jobs: page, count: page.length, truncated, limit };
  }
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
 * Shadow drafts are not mailbox drafts: they are recorded only when the stub
 * itself returns a `draft_id`.
 */
export class DraftState {
  private drafts = new Map<string, DraftRecord>();

  recordWrite(toolName: string, data: Json, input: Json): Json {
    if (toolName === 'ceo-inbox-draft-edit') return this.recordEdit(data, input);
    if (toolName === 'ceo-inbox-draft-compose' || toolName === 'ceo-inbox-draft-reply' || toolName === 'ceo-inbox-shadow-draft') {
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
    let to: unknown = prev?.to ?? [];
    if (input['recipients'] !== undefined) to = input['recipients'];
    if (input['to'] !== undefined) to = input['to'];
    if (data['to'] !== undefined) to = data['to'];
    let cc: unknown = prev?.cc ?? [];
    if (input['cc'] !== undefined) cc = input['cc'];
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
    const prev = this.drafts.get(id) ?? { id, subject: '', to: [], cc: [], body: '' };
    const next: DraftRecord = { ...prev, id };
    if (typeof input['subject'] === 'string') next.subject = input['subject'];
    if (typeof input['body'] === 'string') next.body = input['body'];
    if (input['to'] !== undefined) next.to = input['to'];
    if (input['cc'] !== undefined) next.cc = input['cc'];
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
    if (!this.dirty()) return data;
    const listed = data['tasks'];
    if (!Array.isArray(listed)) return data;
    const { rows, extras } = mergeRows(listed, 'task_id', this.created, this.updates);
    const narrowing = input['status'] !== undefined || input['owner'] !== undefined
      || input['tag'] !== undefined || input['parent_task_id'] !== undefined || input['due_before'] !== undefined;
    let tasks: unknown[] = narrowing ? [...rows] : [...rows, ...extras];
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
    const limit = clampLimit(input['limit'], 25, 100);
    const page = tasks.slice(0, limit);
    return { ...data, tasks: page, count: page.length };
  }
}

/** Per-case write memory for every tool family whose reads should reflect its writes. */
export class SmokeToolState {
  readonly calendar = new CalendarState();
  readonly scheduler = new SchedulerState();
  readonly drafts = new DraftState();
  readonly tasks = new TaskState();
}

const CALENDAR_WRITES: ReadonlySet<string> = new Set(['calendar-create-event', 'calendar-update-event', 'calendar-delete-event']);
const SCHEDULER_WRITES: ReadonlySet<string> = new Set(['scheduler-create', 'scheduler-update', 'scheduler-cancel']);
const DRAFT_WRITES: ReadonlySet<string> = new Set([
  'ceo-inbox-draft-compose', 'ceo-inbox-draft-reply', 'ceo-inbox-shadow-draft', 'ceo-inbox-draft-edit',
]);
const TASK_WRITES: ReadonlySet<string> = new Set(['task-create', 'task-update', 'task-complete']);

/**
 * Record a stubbed scheduler, draft or task write and replay it onto a later list.
 * Placeholders and the calendar/mail query filters stay in `shapeStubResult`: the
 * scenario layer calls this on data that is already resolved.
 */
export function applyCaseWrites(toolName: string, data: Json, input: Json, state: SmokeToolState): Json {
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
  state: SmokeToolState,
  stubMatch: Record<string, unknown> | undefined,
): Json | undefined {
  if (toolName !== 'ceo-inbox-read') return undefined;
  if (stubMatch !== undefined && Object.hasOwn(stubMatch, 'draft_id')) return undefined;
  return state.drafts.read(input);
}

const FILTERS: Partial<Record<string, (data: Json, input: Json) => Json>> = {
  'calendar-list-events': filterEvents,
  'calendar-find-free-time': filterFreeWindows,
  'ceo-inbox-list': (data, input) => filterMail(data, input, false),
  'ceo-inbox-search': (data, input) => filterMail(data, input, true),
};

/**
 * A stubbed result as the real tool would have answered this call. With a SmokeToolState,
 * writes are recorded and later listings and draft reads include them.
 */
export function shapeStubResult(toolName: string, data: unknown, input: Json, state?: SmokeToolState): unknown {
  const filled = fillInputPlaceholders(data, input);
  if (filled === null || typeof filled !== 'object' || Array.isArray(filled)) return filled;
  let shaped = filled as Json;
  if (state) {
    if (CALENDAR_WRITES.has(toolName)) shaped = state.calendar.recordWrite(toolName, shaped, input);
    shaped = applyCaseWrites(toolName, shaped, input, state);
    if (toolName === 'calendar-list-events') shaped = state.calendar.replayOnto(shaped);
  }
  const filter = FILTERS[toolName];
  return filter ? filter(shaped, input) : shaped;
}
