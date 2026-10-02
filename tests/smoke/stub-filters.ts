// tests/smoke/stub-filters.ts — make list/search stubs answer the question asked (#1956).
//
// A stub returns the same fixture whatever the arguments, but calendar and mailbox reads
// are queries: "Wednesday's events", "mail from Priya". Returning the whole fixture would
// hand the model events outside its window or messages that don't match its search —
// something the real tools never do. These filters narrow a stubbed result by the call's
// arguments, the way the real tool would, so one shared fixture serves every query.
//
// They also fill `{{input:<arg>}}` in a stubbed result with the call's own argument, so a
// stubbed write (calendar-create-event, task-create) echoes back what was asked for, and a
// CalendarState makes a case's calendar writes visible to its later reads: the calendar
// specialist re-reads the day to verify what it wrote, and a stateless fixture made it
// report every write as lost.

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

const WRITES: ReadonlySet<string> = new Set(['calendar-create-event', 'calendar-update-event', 'calendar-delete-event']);

const FILTERS: Partial<Record<string, (data: Json, input: Json) => Json>> = {
  'calendar-list-events': filterEvents,
  'calendar-find-free-time': filterFreeWindows,
  'ceo-inbox-list': (data, input) => filterMail(data, input, false),
  'ceo-inbox-search': (data, input) => filterMail(data, input, true),
};

/**
 * A stubbed result as the real tool would have answered this call. With a CalendarState,
 * writes are recorded and listings include them.
 */
export function shapeStubResult(toolName: string, data: unknown, input: Json, calendar?: CalendarState): unknown {
  const filled = fillInputPlaceholders(data, input);
  if (filled === null || typeof filled !== 'object' || Array.isArray(filled)) return filled;
  let shaped = filled as Json;
  if (calendar && WRITES.has(toolName)) shaped = calendar.recordWrite(toolName, shaped, input);
  if (calendar && toolName === 'calendar-list-events') shaped = calendar.replayOnto(shaped);
  const filter = FILTERS[toolName];
  return filter ? filter(shaped, input) : shaped;
}
