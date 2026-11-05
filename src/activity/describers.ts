// describers.ts — per-tool describers for the activity feed (#2251) and the
// activity-log skill.
//
// A describer turns one tool call (its input plus its result data) into a line
// a principal can read: "drafted a reply to John Doe", "scheduled "Board
// Meeting" on Oct 31". Each describer also sets how prominent the call is:
//
//   line   — the call gets its own line (drafts, sends, calendar writes, contacts, documents)
//   count  — the call is folded into a tally on the job's line (archive, label, mark-read)
//   hidden — plumbing the principal never needs to see (config-store, profile reads)
//
// action_risk can't make this call on its own: config-store and
// ceo-inbox-draft-reply are both `low`, but only one belongs in the feed. A unit
// test (tests/unit/activity/describers.test.ts) fails when a tool at `medium` or
// above has no describer here.
//
// Tools this file can't know about (MCP servers, custom agents) get a describer
// learned per agent and stored in the activity_describers table (ADR-059,
// learned-describers.ts). Lookup order: a describer here, then a learned row, then
// the feed's fallback. A describer here always wins, so keep shipped tools here.
//
// Content policy: describers use names, subjects, event titles and counts.
// They never read a `body`, `message`, `content` or `prompt` field, because
// console access is one shared secret and the operator may not be the principal.

import { isScratchDocumentPath } from '../agents/document-workspace.js';

export type Prominence = 'line' | 'count' | 'hidden';

/** One tool call, as the projection hands it to a describer. */
export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  /** `result.data` on success; null on failure or when the data is not an object. */
  data: Record<string, unknown> | null;
  ok: boolean;
}

export interface DescribeContext {
  /**
   * Display name for a reference returned by a describer's `refs()`: a contact
   * id, the alias `principal`, or `email:<address>`. Null when nothing resolved.
   */
  name(ref: string): string | null;
  /** IANA timezone dates are written in (the principal's). */
  timezone: string;
}

/** How a call is counted when several are folded into one phrase. */
export interface Tally {
  verb: string;
  /** Singular object with its article: "a reply". */
  one: string;
  /** Plural object: "replies". */
  many: string;
}

/** What a web tool contributes to a job's research rollup. */
export type ResearchKind = 'search' | 'page';

export interface ToolDescription {
  prominence: Prominence;
  /** Past tense on success ("drafted a reply to …"), "couldn't …" on failure. Empty when hidden. */
  text: string;
  tally?: Tally;
  research?: ResearchKind;
}

interface DescriberShared {
  tally?: Tally;
  research?: ResearchKind;
  /** Name references this call needs resolved before `done`/`attempt` run. */
  refs?(call: ToolCall): string[];
  /** Success text. Returning null hides this particular call (e.g. a dry run). */
  done?(call: ToolCall, ctx: DescribeContext): string | null;
  /** Infinitive for the failure line, rendered as "couldn't <attempt>". */
  attempt?(call: ToolCall, ctx: DescribeContext): string;
}

/**
 * A hidden describer has no minutes: the feed and the tile both skip it.
 * A line or count must declare minutes. A number is the flat guess; a function
 * is for a call whose worth depends on what it did (a new document versus an edit).
 */
type Describer =
  | (DescriberShared & { prominence: 'hidden' })
  | (DescriberShared & {
      prominence: 'line' | 'count';
      minutes: number | ((call: ToolCall) => number);
    });

// -- helpers --

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function truncate(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function quote(text: string): string {
  return `“${truncate(text)}”`;
}

/** Strip the optional `#label` hint from a recipient reference (`principal#work`). */
function bareRef(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const hash = s.indexOf('#');
  return hash > 0 ? s.slice(0, hash) : s;
}

/** The channel named in an activity line. */
function fallbackChannelLabel(channel: string): string {
  if (channel === 'signal') return 'Signal';
  if (channel === 'sms') return 'SMS';
  if (channel === 'slack') return 'Slack';
  if (channel === 'email') return 'email';
  return channel;
}

/** A reference's display name, or a neutral fallback that never leaks an id. */
function who(ref: string | null, ctx: DescribeContext): string {
  if (!ref) return 'someone';
  const name = ctx.name(ref);
  if (name) return truncate(name, 40);
  if (ref.startsWith('email:')) return ref.slice('email:'.length);
  if (ref === 'principal') return 'the principal';
  return 'a contact';
}

/** Addresses out of `[{ name?, email }]` or a comma-separated string. */
function addresses(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((a) => a.trim()).filter((a) => a.includes('@'));
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const email = typeof entry === 'string' ? entry : str(rec(entry)?.email);
    if (email && email.includes('@')) out.push(email.trim());
  }
  return out;
}

function emailRefs(value: unknown): string[] {
  return addresses(value).map((a) => `email:${a.toLowerCase()}`);
}

/** "John Doe", "John Doe and Jane Roe", "John Doe and 2 others". */
function people(refs: string[], ctx: DescribeContext): string {
  if (refs.length === 0) return 'someone';
  const first = who(refs[0]!, ctx);
  if (refs.length === 1) return first;
  if (refs.length === 2) return `${first} and ${who(refs[1]!, ctx)}`;
  return `${first} and ${refs.length - 1} others`;
}

function formatDay(value: unknown, timezone: string): string | null {
  const s = str(value);
  if (!s) return null;
  // An all-day value ("2026-10-31") is a calendar date, not an instant. Date parses it as
  // UTC midnight, which a zone west of UTC would show as the day before, so format it in UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const day = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) return null;
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(day);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: timezone }).format(d);
  } catch {
    // An invalid IANA name in config throws RangeError; UTC is the safe reading.
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  }
}

function eventTitle(call: ToolCall): string | null {
  return str(rec(call.data?.event)?.title) ?? str(call.input.title);
}

function eventStart(call: ToolCall): unknown {
  return rec(call.data?.event)?.startTime ?? call.input.start;
}

function contactRef(field: string) {
  return (call: ToolCall): string[] => {
    const ref = bareRef(call.input[field]) ?? bareRef(call.data?.[field]);
    return ref ? [ref] : [];
  };
}

function onDay(call: ToolCall, ctx: DescribeContext): string {
  const day = formatDay(eventStart(call), ctx.timezone);
  return day ? ` on ${day}` : '';
}

const HIDDEN: Describer = { prominence: 'hidden' };

const EMAIL_COUNT_TALLY = (verb: string): Tally => ({ verb, one: 'an email', many: 'emails' });

// The subject in `done` never reaches a feed headline: count-prominence calls
// render through their tally ("archived 3 emails"). It is for the activity-log
// skill's per-action `summary`, which reports each call on its own.
function emailCount(verb: string, attempt: string, minutes: number): Describer {
  return {
    prominence: 'count',
    minutes,
    tally: EMAIL_COUNT_TALLY(verb),
    done: (call) => {
      const subject = str(call.data?.subject);
      return subject ? `${verb} ${quote(subject)}` : `${verb} an email`;
    },
    attempt: () => attempt,
  };
}

function draftRecipients(call: ToolCall): string[] {
  const fromData = emailRefs(call.data?.to);
  if (fromData.length > 0) return fromData;
  const ids = Array.isArray(call.input.to) ? call.input.to : [call.input.to];
  return [
    ...ids.map(bareRef).filter((r): r is string => r !== null),
    ...emailRefs(call.input.to_addresses),
  ];
}

/** email-send's recipient: the contact reference it was given, else the address it reports. */
function sendTo(call: ToolCall): string | null {
  return bareRef(call.input.to) ?? emailRefs(call.data?.to)[0] ?? null;
}

/** A new document the principal would have written. An edit is a few lines. */
const DOC_CREATED_MINUTES = 15;
const DOC_EDIT_MINUTES = 3;

function isScratchWrite(call: ToolCall): boolean {
  const fromDoc = str(rec(call.data?.document)?.path);
  const fromInput = str(call.input.path);
  return (fromDoc !== null && isScratchDocumentPath(fromDoc))
    || (fromInput !== null && isScratchDocumentPath(fromInput));
}

function docWriteMinutes(call: ToolCall): number {
  if (isScratchWrite(call) || call.data?.conflict === true) return 0;
  return call.data?.action === 'created' ? DOC_CREATED_MINUTES : DOC_EDIT_MINUTES;
}

const REPLY_DRAFT_TALLY: Tally = { verb: 'drafted', one: 'a reply', many: 'replies' };
const EMAIL_DRAFT_TALLY: Tally = { verb: 'drafted', one: 'an email', many: 'emails' };

// -- the registry --
//
// `minutes` guesses how long the principal would have spent doing the thing
// once. Anchors from #2349: archiving an email 0.5, drafting a reply 5,
// scheduling a meeting 10. Twin tools that are the same action share a number.
// email-send is the whole job (write and send), so it matches a draft.
// dispatcher-relay only delivers a reply that was already approved.
// A new document is worth more than an edit. Scratch notes are hidden.
// A hidden describer is an explicit zero. A call with no describer, a read
// included, takes UNDESCRIBED_CALL_MINUTES (ADR-058).

const DESCRIBERS: Record<string, Describer> = {
  // ── Mail drafts and sends ────────────────────────────────────────────────
  'ceo-inbox-draft-reply': {
    prominence: 'line',
    minutes: 5,
    tally: REPLY_DRAFT_TALLY,
    refs: (call) => emailRefs(call.data?.to),
    done: (call, ctx) => `drafted a reply to ${people(emailRefs(call.data?.to), ctx)}`,
    attempt: () => 'draft a reply',
  },
  'ceo-inbox-draft-compose': {
    prominence: 'line',
    minutes: 5,
    tally: EMAIL_DRAFT_TALLY,
    refs: draftRecipients,
    done: (call, ctx) => `drafted an email to ${people(draftRecipients(call), ctx)}`,
    attempt: () => 'draft an email',
  },
  'ceo-inbox-draft-edit': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'updated', one: 'a draft', many: 'drafts' },
    refs: (call) => emailRefs(call.data?.to),
    done: (call, ctx) => {
      const to = emailRefs(call.data?.to);
      return to.length > 0 ? `updated a draft to ${people(to, ctx)}` : 'updated a draft';
    },
    attempt: () => 'update a draft',
  },
  'email-draft-save': {
    prominence: 'line',
    minutes: 5,
    tally: EMAIL_DRAFT_TALLY,
    refs: contactRef('to'),
    done: (call, ctx) => {
      const what = str(call.input.reply_to_message_id) ? 'a reply' : 'an email';
      return `drafted ${what} to ${who(bareRef(call.input.to), ctx)}`;
    },
    attempt: (call, ctx) => `draft an email to ${who(bareRef(call.input.to), ctx)}`,
  },
  'email-send': {
    prominence: 'line',
    minutes: 5,
    tally: { verb: 'sent', one: 'an email', many: 'emails' },
    refs: (call) => { const r = sendTo(call); return r ? [r] : []; },
    done: (call, ctx) => {
      const to = who(sendTo(call), ctx);
      return call.data?.deferred_to_digest === true
        ? `queued an email to ${to} for the digest`
        : `emailed ${to}`;
    },
    attempt: (call, ctx) => `email ${who(sendTo(call), ctx)}`,
  },
  'email-reply': {
    prominence: 'line',
    minutes: 5,
    tally: { verb: 'sent', one: 'a reply', many: 'replies' },
    refs: (call) => emailRefs(call.data?.to),
    done: (call, ctx) => {
      const to = emailRefs(call.data?.to);
      if (call.data?.deferred_to_digest === true) return 'queued a reply for the digest';
      return to.length > 0 ? `replied to ${people(to, ctx)}` : 'sent a reply';
    },
    attempt: () => 'send a reply',
  },
  'dispatcher-relay': {
    prominence: 'line',
    minutes: 1,
    tally: { verb: 'sent', one: 'a reply', many: 'replies' },
    refs: (call) => emailRefs(call.input.to),
    done: (call, ctx) => {
      const to = emailRefs(call.input.to);
      return to.length > 0 ? `sent an approved reply to ${people(to, ctx)}` : 'sent an approved reply';
    },
    attempt: () => 'send an approved reply',
  },
  'signal-send': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'sent', one: 'a Signal message', many: 'Signal messages' },
    refs: contactRef('recipient'),
    done: (call, ctx) => (str(call.input.group_id) && !str(call.input.recipient)
      ? 'messaged a Signal group'
      : `messaged ${who(bareRef(call.input.recipient), ctx)} on Signal`),
    attempt: (call, ctx) => `message ${who(bareRef(call.input.recipient), ctx)} on Signal`,
  },
  'sms-send': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'sent', one: 'a text', many: 'texts' },
    refs: contactRef('recipient'),
    done: (call, ctx) => `texted ${who(bareRef(call.input.recipient), ctx)}`,
    attempt: (call, ctx) => `text ${who(bareRef(call.input.recipient), ctx)}`,
  },
  'web-send': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'sent', one: 'a phone message', many: 'phone messages' },
    refs: contactRef('recipient'),
    done: (call, ctx) => {
      const channel = str(call.data?.channel);
      const person = who(bareRef(call.input.recipient), ctx);
      if (call.data?.deferred_to_digest === true) return `queued a message to ${person} for the digest`;
      if (channel && channel !== 'web') return `messaged ${person} on ${fallbackChannelLabel(channel)}`;
      return `messaged ${person} on the phone app`;
    },
    attempt: (call, ctx) => `message ${who(bareRef(call.input.recipient), ctx)} on the phone app`,
  },
  'slack-send': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'sent', one: 'a Slack message', many: 'Slack messages' },
    refs: contactRef('recipient'),
    done: (call, ctx) => `messaged ${who(bareRef(call.input.recipient), ctx)} on Slack`,
    attempt: (call, ctx) => `message ${who(bareRef(call.input.recipient), ctx)} on Slack`,
  },

  // ── Mailbox housekeeping (folded into counts) ────────────────────────────
  'ceo-inbox-archive': emailCount('archived', 'archive an email', 0.5),
  'email-archive': emailCount('archived', 'archive an email', 0.5),
  'ceo-inbox-label': emailCount('labelled', 'label an email', 0.5),
  'email-label': emailCount('labelled', 'label an email', 0.5),
  'ceo-inbox-mark-read': {
    prominence: 'count',
    minutes: 0.5,
    tally: { verb: 'marked', one: 'an email read', many: 'emails read' },
    done: () => 'marked an email read',
    attempt: () => 'mark an email read',
  },
  'email-mark-read': {
    prominence: 'count',
    minutes: 0.5,
    tally: { verb: 'marked', one: 'an email read', many: 'emails read' },
    done: () => 'marked an email read',
    attempt: () => 'mark an email read',
  },
  'ceo-inbox-mark-starred': emailCount('starred', 'star an email', 0.5),
  'ceo-inbox-update-folders': emailCount('filed', 'file an email', 1),

  // ── Calendar ─────────────────────────────────────────────────────────────
  'calendar-create-event': {
    prominence: 'line',
    minutes: 10,
    tally: { verb: 'scheduled', one: 'an event', many: 'events' },
    done: (call, ctx) => `scheduled ${quote(eventTitle(call) ?? 'an event')}${onDay(call, ctx)}`,
    attempt: (call) => `schedule ${quote(eventTitle(call) ?? 'an event')}`,
  },
  'calendar-update-event': {
    prominence: 'line',
    minutes: 5,
    tally: { verb: 'updated', one: 'an event', many: 'events' },
    done: (call, ctx) => {
      const title = quote(eventTitle(call) ?? 'an event');
      if (call.input.start !== undefined) {
        const day = formatDay(eventStart(call), ctx.timezone);
        return day ? `moved ${title} to ${day}` : `rescheduled ${title}`;
      }
      return `updated ${title}`;
    },
    attempt: (call) => `update ${quote(eventTitle(call) ?? 'an event')}`,
  },
  'calendar-delete-event': {
    prominence: 'line',
    minutes: 1,
    tally: { verb: 'deleted', one: 'an event', many: 'events' },
    done: () => 'deleted a calendar event',
    attempt: () => 'delete a calendar event',
  },
  'calendar-create-hold': {
    prominence: 'line',
    minutes: 3,
    tally: { verb: 'held', one: 'a time slot', many: 'time slots' },
    done: (call, ctx) => {
      if (call.data?.held !== true) return null;
      const subject = str(call.input.subject);
      const day = formatDay(call.input.start, ctx.timezone);
      return `held time${subject ? ` for ${quote(subject)}` : ''}${day ? ` on ${day}` : ''}`;
    },
    attempt: () => 'place a calendar hold',
  },
  'calendar-respond-to-invite': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'answered', one: 'an invite', many: 'invites' },
    done: (call) => {
      const response = str(call.data?.response) ?? str(call.input.response);
      const title = quote(eventTitle(call) ?? 'an invite');
      if (response === 'accept') return `accepted ${title}`;
      if (response === 'decline') return `declined ${title}`;
      if (response === 'tentative') return `tentatively accepted ${title}`;
      return `answered ${title}`;
    },
    attempt: () => 'answer an invite',
  },
  'calendar-register': {
    prominence: 'line',
    minutes: 5,
    done: (call) => `linked the ${quote(str(call.input.label) ?? 'new')} calendar`,
    attempt: () => 'link a calendar',
  },

  // ── Contacts and permissions ─────────────────────────────────────────────
  'contact-create': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'added', one: 'a contact', many: 'contacts' },
    done: (call) => `added ${truncate(str(call.data?.display_name) ?? str(call.input.name) ?? 'a contact', 40)} to contacts`,
    attempt: (call) => `add ${truncate(str(call.input.name) ?? 'a contact', 40)} to contacts`,
  },
  'contact-update': {
    prominence: 'count',
    minutes: 2,
    tally: { verb: 'updated', one: 'a contact', many: 'contacts' },
    refs: contactRef('contact_id'),
    done: (call, ctx) => `updated ${who(bareRef(call.input.contact_id), ctx)}'s details`,
    attempt: () => 'update a contact',
  },
  'contact-rename': {
    prominence: 'line',
    minutes: 1,
    done: (call) => `renamed a contact to ${truncate(str(call.input.display_name) ?? 'a new name', 40)}`,
    attempt: () => 'rename a contact',
  },
  'contact-merge': {
    prominence: 'line',
    minutes: 5,
    refs: contactRef('primary_contact_id'),
    done: (call, ctx) => (call.input.dry_run === true
      ? null
      : `merged two contacts into ${who(bareRef(call.input.primary_contact_id), ctx)}`),
    attempt: () => 'merge two contacts',
  },
  'contact-set-role': {
    prominence: 'line',
    minutes: 1,
    refs: contactRef('contact_id'),
    done: (call, ctx) => `set ${who(bareRef(call.input.contact_id), ctx)}'s role to ${truncate(str(call.input.role) ?? 'a new role', 30)}`,
    attempt: () => "change a contact's role",
  },
  'contact-set-tier': {
    prominence: 'line',
    minutes: 1,
    refs: contactRef('contact_id'),
    done: (call, ctx) => `marked ${who(bareRef(call.input.contact_id), ctx)} as ${str(call.input.tier) ?? 'a new tier'}`,
    attempt: () => "change a contact's tier",
  },
  'contact-grant-permission': {
    prominence: 'line',
    minutes: 2,
    refs: contactRef('contact_id'),
    done: (call, ctx) => {
      const name = who(bareRef(call.input.contact_id), ctx);
      const permission = quote(str(call.input.permission) ?? 'a permission');
      return call.input.granted === false ? `denied ${name} ${permission}` : `granted ${name} ${permission}`;
    },
    attempt: () => 'change a permission',
  },
  'contact-revoke-permission': {
    prominence: 'line',
    minutes: 2,
    refs: contactRef('contact_id'),
    done: (call, ctx) => `removed ${quote(str(call.input.permission) ?? 'a permission')} from ${who(bareRef(call.input.contact_id), ctx)}`,
    attempt: () => 'remove a permission',
  },
  'approve-grant-recommendation': {
    prominence: 'line',
    minutes: 2,
    refs: (call) => { const r = bareRef(call.data?.contact_id); return r ? [r] : []; },
    done: (call, ctx) => {
      const permission = str(call.data?.permission);
      const target = bareRef(call.data?.contact_id);
      return `approved ${permission ? quote(permission) : 'a permission'}${target ? ` for ${who(target, ctx)}` : ''}`;
    },
    attempt: () => 'approve a permission',
  },
  'decline-grant-recommendation': {
    prominence: 'line',
    minutes: 1,
    done: () => 'declined a permission recommendation',
    attempt: () => 'decline a permission recommendation',
  },
  'set-autonomy': {
    prominence: 'line',
    minutes: 2,
    done: (call) => (typeof call.input.score === 'number' ? `set autonomy to ${call.input.score}` : 'changed the autonomy score'),
    attempt: () => 'change the autonomy score',
  },

  // ── Voice and learning ───────────────────────────────────────────────────
  'executive-profile-update': {
    prominence: 'line',
    minutes: 5,
    done: () => 'updated the writing-voice profile',
    attempt: () => 'update the writing-voice profile',
  },
  'voice-learn': {
    prominence: 'line',
    minutes: 2,
    done: (call) => (call.data?.proposed === true || (typeof call.data?.proposed === 'number' && call.data.proposed > 0)
      ? 'proposed a writing-voice update'
      : null),
    attempt: () => 'learn from sent mail',
  },
  'resolve-learning-digest': {
    prominence: 'line',
    minutes: 2,
    done: (call) => {
      switch (call.input.action) {
        case 'approve_voice': return 'approved a writing-voice update';
        case 'dismiss_voice': return 'dismissed a writing-voice update';
        case 'undo_completion': return 'reopened a task';
        case 'confirm_completion': return 'confirmed a task was done';
        default: return 'resolved a digest item';
      }
    },
    attempt: () => 'resolve a digest item',
  },

  // ── Documents, tasks, jobs ───────────────────────────────────────────────
  'doc-write': {
    prominence: 'line',
    minutes: docWriteMinutes,
    tally: { verb: 'wrote', one: 'a document', many: 'documents' },
    done: (call) => {
      // A version mismatch is success: true with conflict: true, and nothing was written.
      if (isScratchWrite(call) || call.data?.conflict === true) return null;
      const doc = rec(call.data?.document);
      const title = str(rec(doc?.frontmatter)?.title) ?? str(doc?.path) ?? str(call.input.path) ?? 'a document';
      const verb = call.data?.action === 'created' ? 'wrote' : 'updated';
      return `${verb} ${quote(title)}`;
    },
    attempt: (call) => `write ${quote(str(call.input.path) ?? 'a document')}`,
  },
  'task-create': {
    prominence: 'line',
    minutes: 2,
    tally: { verb: 'added', one: 'a task', many: 'tasks' },
    done: (call) => `added the task ${quote(str(call.data?.title) ?? str(call.input.title) ?? 'untitled')}`,
    attempt: () => 'add a task',
  },
  'task-complete': {
    prominence: 'line',
    minutes: 1,
    tally: { verb: 'completed', one: 'a task', many: 'tasks' },
    done: (call) => {
      const title = str(call.data?.title);
      return title ? `completed the task ${quote(title)}` : 'completed a task';
    },
    attempt: () => 'complete a task',
  },
  'task-update': {
    prominence: 'count',
    minutes: 1,
    tally: { verb: 'updated', one: 'a task', many: 'tasks' },
    done: (call) => {
      const title = str(call.data?.title);
      return title ? `updated the task ${quote(title)}` : 'updated a task';
    },
    attempt: () => 'update a task',
  },
  'scheduler-create': {
    prominence: 'line',
    minutes: 5,
    done: () => 'set up a scheduled job',
    attempt: () => 'set up a scheduled job',
  },
  'scheduler-cancel': {
    prominence: 'line',
    minutes: 1,
    done: () => 'cancelled a scheduled job',
    attempt: () => 'cancel a scheduled job',
  },
  'scheduler-update': {
    prominence: 'line',
    minutes: 2,
    done: (call) => {
      if (call.input.action === 'pause') return 'paused a scheduled job';
      if (call.input.action === 'resume') return 'resumed a scheduled job';
      return 'changed a scheduled job';
    },
    attempt: () => 'change a scheduled job',
  },
  'image-generate': {
    prominence: 'line',
    minutes: 5,
    tally: { verb: 'generated', one: 'an image', many: 'images' },
    done: () => 'generated an image',
    attempt: () => 'generate an image',
  },
  'file-parse': {
    prominence: 'count',
    minutes: 0,
    tally: { verb: 'read', one: 'a file', many: 'files' },
    done: (call) => { const f = str(call.input.filename); return f ? `read ${quote(f)}` : 'read a file'; },
    attempt: () => 'read a file',
  },

  // ── Research (feeds the job's rollup, never its own line) ────────────────
  'web-search': { prominence: 'hidden', research: 'search' },
  'web-fetch': { prominence: 'hidden', research: 'page' },
  'web-browser': { prominence: 'hidden', research: 'page' },

  // ── Plumbing ─────────────────────────────────────────────────────────────
  'config-store': HIDDEN,
  'executive-profile-get': HIDDEN,
  'scheduler-report': HIDDEN,
  'checkpoint': HIDDEN,
  'plan': HIDDEN,
  'delegate': HIDDEN,
  'memory-store': HIDDEN,
  'memory-confirm': HIDDEN,
  'extract-facts': HIDDEN,
  'extract-relationships': HIDDEN,
  'activity-log': HIDDEN,
  // Shipped tools whose success is not the principal's time. Hidden is an
  // explicit zero, so these calls are outside the undescribed backstop.
  // `bullpen` is the bundle name, not a tool. `approval-expiry-sweep` is a
  // system interval, not a tool (#2013). Neither gets an entry.
  'ceo-inbox-list': HIDDEN,
  'task-list': HIDDEN,
  'contact-register': HIDDEN,
  'bullpen-post': HIDDEN,
  'ceo-inbox-shadow-draft': HIDDEN,
};

// Own keys only: DESCRIBERS is a plain object, so a tool named "constructor" or
// "toString" would otherwise resolve to an Object.prototype member.
function lookup(toolName: string): Describer | undefined {
  return Object.hasOwn(DESCRIBERS, toolName) ? DESCRIBERS[toolName] : undefined;
}

/** True when the registry has an entry for this tool (hidden entries count). */
export function hasDescriber(toolName: string): boolean {
  return lookup(toolName) !== undefined;
}

/** Names of every tool with a describer. */
export function describedToolNames(): string[] {
  return Object.keys(DESCRIBERS);
}

/** True when a successful call of this tool would show in the feed as a line or count. */
export function isVisibleTool(toolName: string): boolean {
  const d = lookup(toolName);
  return d !== undefined && d.prominence !== 'hidden';
}

/** Tools marked hidden. The feed also skips tools with no describer. */
export function hiddenToolNames(): readonly string[] {
  return Object.entries(DESCRIBERS)
    .filter(([, describer]) => describer.prominence === 'hidden')
    .map(([name]) => name);
}

/**
 * Tools the activity feed classifies: described, and not hidden.
 * The histogram counts only these, so an undescribed read cannot become a hiccup.
 */
export function visibleToolNames(): readonly string[] {
  return Object.entries(DESCRIBERS)
    .filter(([, describer]) => describer.prominence !== 'hidden')
    .map(([name]) => name);
}

/** Names resolve to nothing. Hide/show decisions in `done()` do not depend on them. */
const MINUTES_CTX: DescribeContext = { name: () => null, timezone: 'UTC' };

/**
 * Human-time backstop for a successful call the describers do not name (ADR-058).
 * The census estimated 2,390 minutes of human effort. After the five shipped
 * zero-effort tools above were marked hidden, 24,393 calls remained undescribed:
 * 2,390 / 24,393 = 0.098 minutes.
 */
export const UNDESCRIBED_CALL_MINUTES = 0.098;

/**
 * Principal-minutes for one successful call.
 * A named tool uses its describer. A hidden describer, a failed call, a blank
 * name, or a `done()` that returns null (a dry-run merge, an unplaced hold,
 * scratch notes) is zero. Any other name is the undescribed-call default.
 */
export function minutesForCall(call: ToolCall): number {
  if (!call.ok) return 0;
  if (!hasDescriber(call.toolName)) {
    return call.toolName.trim().length > 0 ? UNDESCRIBED_CALL_MINUTES : 0;
  }
  const shown = describeToolCall(call, MINUTES_CTX);
  if (!shown || shown.prominence === 'hidden') return 0;
  const describer = lookup(call.toolName);
  if (!describer || describer.prominence === 'hidden') return 0;
  const raw = typeof describer.minutes === 'function' ? describer.minutes(call) : describer.minutes;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function flatMinutes(toolName: string): number {
  const describer = lookup(toolName);
  if (!describer || describer.prominence === 'hidden' || typeof describer.minutes !== 'number') {
    throw new Error(`time-saved help: ${toolName} has no flat minute weight`);
  }
  return describer.minutes;
}

/** Always-visible footnote. One short line; the weights live on hover. */
export function timeSavedHelp(): string {
  return 'Rough estimate of equivalent human effort.';
}

/**
 * Hover note for the number and the footnote. Weights come from the describers
 * so the sentence cannot drift.
 */
export function timeSavedDetail(): string {
  const meeting = flatMinutes('calendar-create-event');
  const reply = flatMinutes('ceo-inbox-draft-reply');
  const filing = flatMinutes('email-archive');
  const filingText = filing === 0.5 ? '½' : String(filing);
  return `A meeting ≈${meeting} min, a reply ≈${reply}, filing ≈${filingText}. A new document ≈${DOC_CREATED_MINUTES} min, an edit ≈${DOC_EDIT_MINUTES}. Known lookups don't count. Other tool work counts a few seconds each. Each action counts, including a repeat.`;
}

/** Research kind of a web tool, or undefined. */
export function researchKind(toolName: string): ResearchKind | undefined {
  return lookup(toolName)?.research;
}

/** Name references a call needs resolved; empty for tools without a describer. */
export function describerRefs(call: ToolCall): string[] {
  return lookup(call.toolName)?.refs?.(call) ?? [];
}

/**
 * Describe one tool call. Null when the tool has no describer — the projection
 * then treats it as hidden.
 */
export function describeToolCall(call: ToolCall, ctx: DescribeContext): ToolDescription | null {
  const d = lookup(call.toolName);
  if (!d) return null;
  const base = { tally: d.tally, research: d.research };
  if (d.prominence === 'hidden') return { prominence: 'hidden', text: '', ...base };
  if (call.ok) {
    const text = d.done?.(call, ctx) ?? null;
    if (text === null) return { prominence: 'hidden', text: '', ...base };
    return { prominence: d.prominence, text, ...base };
  }
  const attempt = d.attempt?.(call, ctx) ?? `run ${call.toolName}`;
  return { prominence: d.prominence, text: `couldn't ${attempt}`, ...base };
}

/** "drafted a reply" / "drafted 3 replies". */
export function formatTally(tally: Tally, count: number): string {
  return count === 1 ? `${tally.verb} ${tally.one}` : `${tally.verb} ${count} ${tally.many}`;
}

// -- activity-log skill helpers (moved from skills/activity-log/handler.ts) --
//
// The skill's `target` and `detail` fields predate the describers and keep
// their shapes for its callers; its `summary` field comes from describeToolCall.

interface LegacyResult { success?: boolean; data?: unknown; error?: string }

/** Short target for a recap row: recipient, event title, or the tool name. */
export function extractTarget(toolName: string, result?: LegacyResult): string {
  const data = rec(result?.data);
  if (!data) return toolName;

  if (toolName === 'calendar-respond-to-invite') {
    const event = rec(data.event);
    const title = typeof event?.title === 'string' ? event.title : null;
    const response = typeof data.response === 'string' ? data.response : null;
    if (title && response) return `${response} — ${title}`;
    if (title) return title;
    if (response) return response;
  }

  if (toolName.startsWith('email-') || toolName === 'signal-send' || toolName === 'send-draft') {
    const to = data.to ?? data.recipient;
    if (typeof to === 'string') return to;
    if (Array.isArray(to) && typeof to[0] === 'string') return to[0];
  }

  if (toolName.startsWith('calendar-')) {
    const event = rec(data.event);
    if (typeof event?.title === 'string') return event.title;
  }

  if (typeof data.description === 'string') return data.description;
  if (typeof data.title === 'string') return data.title;
  if (typeof data.subject === 'string') return data.subject;

  return toolName;
}

/** Extra detail for a successful recap row (RSVP outcome, a result message). */
export function extractSuccessDetail(toolName: string, data: unknown): string | null {
  const record = rec(data);
  if (!record) return null;

  if (toolName === 'calendar-respond-to-invite') {
    const response = typeof record.response === 'string' ? record.response : null;
    const released = Array.isArray(record.releasedHolds) ? record.releasedHolds.length : null;
    if (response && released !== null) return `RSVP ${response}; released ${released} hold(s)`;
    if (response) return `RSVP ${response}`;
  }

  if (typeof record.message === 'string') return record.message;
  return null;
}
