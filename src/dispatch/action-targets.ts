// action-targets.ts — read "who/what does this tool call affect" from its input.
//
// The pre-action backstop (#2588) compares these targets against what other
// concurrent turns already acted on. Targets come from the input's values, not
// its field names, so no per-tool knowledge is needed.

import type { Logger } from '../logger.js';
import { isUuid } from '../util/uuid.js';
import type { ActionTarget } from './turn-activity.js';

const MAX_DEPTH = 6;
const MAX_STRINGS = 50;
/** Contact lookups per call, UUID checks and email resolutions together. */
const MAX_CONTACT_LOOKUPS = 10;
const OTHER_ID_RE = /^[A-Za-z0-9_\-:.]+$/;
// A bare address, as calendar attendees and send fields carry it. Not a validator: a
// value that only looks like one is looked up and simply not found.
const EMAIL_RE = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:]+$/;
const EMAIL_MAX = 254;

export interface CandidateValues {
  uuids: string[];
  hosts: string[];
  otherIds: string[];
  /** Email-shaped strings, lowercased. */
  emails: string[];
  /** Strings classified; the walk stops at MAX_STRINGS. */
  stringsSeen: number;
  /** The walk stopped at the string cap. */
  stringCapReached: boolean;
  /** Some container sat deeper than MAX_DEPTH and was skipped. */
  depthCapReached: boolean;
}

function hostOf(s: string): string | undefined {
  if (!/^https?:\/\//i.test(s)) return undefined;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return (host.startsWith('www.') ? host.slice(4) : host) || undefined;
  } catch {
    // Not a parseable URL: it is simply not a site candidate.
    return undefined;
  }
}

/**
 * Walk the input (depth <= 6 below the top-level object, first 50 strings in
 * depth-first insertion order) and classify string values.
 */
export function collectCandidateValues(input: Record<string, unknown>): CandidateValues {
  const uuids = new Set<string>();
  const hosts = new Set<string>();
  const otherIds = new Set<string>();
  const emails = new Set<string>();
  let seen = 0;
  let stringCapReached = false;
  let depthCapReached = false;

  const classify = (s: string): void => {
    // Annotated as boolean so the type guard does not narrow `s` to never below.
    const uuidShaped: boolean = isUuid(s);
    if (uuidShaped) {
      uuids.add(s.toLowerCase());
      return;
    }
    const host = hostOf(s);
    if (host !== undefined) {
      hosts.add(host);
      return;
    }
    const trimmed = s.trim();
    if (trimmed.length <= EMAIL_MAX && EMAIL_RE.test(trimmed)) {
      emails.add(trimmed.toLowerCase());
      return;
    }
    if (s.includes('@') || s.includes('://')) return;
    if (s.length >= 8 && s.length <= 128 && OTHER_ID_RE.test(s) && /\d/.test(s)) {
      otherIds.add(s);
    }
  };

  const walk = (value: unknown, depth: number): void => {
    if (seen >= MAX_STRINGS) {
      stringCapReached = true;
      return;
    }
    if (typeof value === 'string') {
      seen++;
      classify(value);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (depth > MAX_DEPTH) {
      depthCapReached = true;
      return;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      walk(child, depth + 1);
    }
  };

  walk(input, 0);
  return {
    uuids: [...uuids],
    hosts: [...hosts],
    otherIds: [...otherIds],
    emails: [...emails],
    stringsSeen: seen,
    stringCapReached,
    depthCapReached,
  };
}

export interface ActionTargetDeps {
  principalContactId: string | undefined;
  /** Curia's own agent contact; excluded the same way as the principal's. */
  agentContactId?: string | undefined;
  isContact: (id: string) => Promise<boolean>;
  /** The contact an email address belongs to, if any. Without it, emails are ignored. */
  contactIdForEmail?: (email: string) => Promise<string | undefined>;
  /** Addresses never resolved: the principal's and Curia's own. Compared lowercased. */
  excludedEmails?: ReadonlySet<string>;
  /**
   * Addresses the call sends to that its input does not carry: an email-reply goes to the
   * original message's sender and reply-all list, and its input names only that message.
   * Resolved like the input's addresses (needs contactIdForEmail), and before them. A value
   * that is not a bare address (a contact reference) is skipped: it is in the input.
   */
  recipientEmails?: readonly string[];
  /** For lookup failures (warn, id kind only) and truncation (debug, counts only). */
  logger?: Logger;
}

/** An error's class name, never its message: safe for identifier-free logs. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

type Lookup =
  | { kind: 'uuid'; id: string; run: () => Promise<boolean> }
  | { kind: 'email'; run: () => Promise<string | undefined> };

/**
 * Derive the targets of a tool call. Contacts and sites win, so a shared
 * non-contact UUID (e.g. a mailbox) never links two unrelated contact sends.
 * With neither, the call's other ids are its targets (two replies on different
 * threads do not collide). Only a call with no identifiable target at all
 * targets the tool itself.
 *
 * A contact can be named by UUID or by email address (a calendar attendee is
 * `{ email, name }`; a reply's recipients come in as recipientEmails). Both are
 * looked up, at most MAX_CONTACT_LOOKUPS together, UUIDs first. A rejected
 * lookup is logged with its id kind and error class only and counts as
 * not-a-contact; an address that resolves to no contact is ignored.
 */
export async function extractActionTargets(
  toolName: string,
  input: Record<string, unknown>,
  deps: ActionTargetDeps,
): Promise<ActionTarget[]> {
  const collected = collectCandidateValues(input);
  const { uuids, hosts, otherIds } = collected;
  const principal = deps.principalContactId?.toLowerCase();
  const agent = deps.agentContactId?.toLowerCase();
  const candidates = uuids.filter((u) => u !== principal && u !== agent);
  const excluded = deps.excludedEmails;
  const recipientEmails = (deps.recipientEmails ?? [])
    .map((e) => e.trim())
    .filter((e) => e.length <= EMAIL_MAX && EMAIL_RE.test(e))
    .map((e) => e.toLowerCase());
  const emails = deps.contactIdForEmail
    ? [...new Set([...recipientEmails, ...collected.emails])].filter((e) => !(excluded?.has(e) ?? false))
    : [];

  const lookups: Lookup[] = [];
  for (const id of candidates) {
    if (lookups.length >= MAX_CONTACT_LOOKUPS) break;
    lookups.push({ kind: 'uuid', id, run: () => deps.isContact(id) });
  }
  const contactIdForEmail = deps.contactIdForEmail;
  if (contactIdForEmail) {
    for (const email of emails) {
      if (lookups.length >= MAX_CONTACT_LOOKUPS) break;
      lookups.push({ kind: 'email', run: () => contactIdForEmail(email) });
    }
  }
  const lookupCapReached = candidates.length + emails.length > lookups.length;
  if (collected.stringCapReached || collected.depthCapReached || lookupCapReached) {
    deps.logger?.debug(
      {
        toolName,
        stringsSeen: collected.stringsSeen,
        stringCapReached: collected.stringCapReached,
        depthCapReached: collected.depthCapReached,
        lookups: lookups.length,
        lookupCandidates: candidates.length + emails.length,
      },
      'cross-turn backstop: target extraction truncated',
    );
  }

  // Each lookup is wrapped so a synchronous throw is a rejection like any other.
  const settled = await Promise.allSettled(lookups.map(async (l) => l.run()));

  const contactIds: string[] = [];
  const seenContacts = new Set<string>();
  const addContact = (id: string): void => {
    const key = id.toLowerCase();
    if (key === principal || key === agent || seenContacts.has(key)) return;
    seenContacts.add(key);
    contactIds.push(key);
  };
  settled.forEach((outcome, i) => {
    const lookup = lookups[i]!;
    if (outcome.status === 'rejected') {
      // The error's class only: a lookup error's message or stack can quote the address or
      // id it was given, and this log carries no identifiers.
      deps.logger?.warn(
        { errName: errorName(outcome.reason), toolName, idKind: lookup.kind },
        'cross-turn backstop: contact lookup failed — treating the value as not a contact',
      );
      return;
    }
    if (lookup.kind === 'uuid') {
      if (outcome.value === true) addContact(lookup.id);
    } else if (typeof outcome.value === 'string' && isUuid(outcome.value)) {
      addContact(outcome.value);
    }
  });

  const targets: ActionTarget[] = [
    ...contactIds.map((value): ActionTarget => ({ kind: 'contact', value })),
    ...hosts.map((value): ActionTarget => ({ kind: 'site', value })),
  ];
  if (targets.length > 0) return targets;

  const contactSet = new Set(contactIds);
  const ids: ActionTarget[] = [
    ...candidates.filter((u) => !contactSet.has(u)).map((value): ActionTarget => ({ kind: 'id', value })),
    ...otherIds.map((value): ActionTarget => ({ kind: 'id', value })),
  ];
  return ids.length > 0 ? ids : [{ kind: 'tool', value: toolName }];
}
