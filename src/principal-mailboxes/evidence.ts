// Mailbox evidence (#2475, D5): which of the principal's mailboxes has a history with a set
// of recipients. Computed in code from each mailbox's Sent and Inbox so the model gets facts
// instead of guessing. Used to choose the account for new mail (and later, meetings).
//
// One mailbox failing never hides the others: it gets `error` (a class name or HTTP status,
// never a grant id) and zero counts. The per-mailbox lookups run in parallel under a deadline.

import type { SkillPrincipalMailboxes, PrincipalMailboxView } from './service.js';
import type { NylasClient, NylasMessage } from '../channels/email/nylas-client.js';
import { cleanSubject } from '../autonomy/sample-pool.js';
import { nylasStatus } from '../channels/email/nylas-message-id.js';
import type { Logger } from '../logger.js';
import { grantSafeErrorFields } from './error-fields.js';

export interface MailboxEvidence {
  mailbox: string;
  mailbox_label: string;
  sent_count: number;
  last_sent_at: string | null;
  recent_subjects: string[];
  received_count: number;
  domain_match: boolean;
  error?: string;
}

export type EvidenceVerdict = 'agrees' | 'leans_other' | 'none' | 'split';

const DEFAULT_LIMIT = 20;
const MAX_SUBJECTS = 3;
// Any_email takes one address, so each recipient is its own query; keep the fan-out small.
const MAX_RECIPIENTS = 5;
const LOOKUP_TIMEOUT_MS = 8_000;
const SENT_ATTRIBUTE = '\\Sent';
const INBOX_ATTRIBUTE = '\\Inbox';

// Two people on a public mail provider share a domain by accident, not because they work
// together, so a consumer domain never counts as a domain match (R38). The list covers the
// large providers; a miss only adds a weak domain point, never a send.
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'mail.com', 'fastmail.com',
]);

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

function domainMatches(mailboxAddress: string, recipients: string[]): boolean {
  const own = domainOf(mailboxAddress);
  if (own === '' || CONSUMER_DOMAINS.has(own)) return false;
  return recipients.some((r) => domainOf(r) === own);
}

const MAX_SUBJECT_CHARS = 80;

/** A third party's subject, safe to show the model: the shared untrusted-text cleaner, then capped by code point. */
function safeSubject(raw: string): string {
  const points = Array.from(cleanSubject(raw));
  return points.length > MAX_SUBJECT_CHARS ? `${points.slice(0, MAX_SUBJECT_CHARS - 1).join('').trimEnd()}…` : points.join('');
}

/** An error whose name is its label (SF12): TimeoutError, NoSentFolder. */
function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** The HTTP status, else the error's name (TimeoutError, not "Error"). Never a message. */
function errorLabel(err: unknown): string {
  const status = nylasStatus(err);
  if (status !== undefined) return `HTTP ${status}`;
  return err instanceof Error ? err.name : 'Error';
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(namedError('TimeoutError', `mailbox evidence timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Messages in a folder that involve any recipient, deduplicated by id. */
async function foldersMessages(client: NylasClient, folder: string, recipients: string[], limit: number): Promise<NylasMessage[]> {
  const pages = await Promise.all(recipients.map((r) => client.listMessages({ anyEmail: r, folders: [folder], limit })));
  const byId = new Map<string, NylasMessage>();
  for (const m of pages.flat()) byId.set(m.id, m);
  return [...byId.values()];
}

async function one(
  svc: Pick<SkillPrincipalMailboxes, 'list' | 'gatewayClient'>,
  mailbox: PrincipalMailboxView,
  recipients: string[],
  limit: number,
  log: Pick<Logger, 'warn'> | undefined,
): Promise<MailboxEvidence> {
  const base: MailboxEvidence = {
    mailbox: mailbox.id,
    mailbox_label: mailbox.label,
    sent_count: 0,
    last_sent_at: null,
    recent_subjects: [],
    received_count: 0,
    domain_match: domainMatches(mailbox.address, recipients),
  };
  try {
    const wanted = new Set(recipients);
    const compute = async (): Promise<MailboxEvidence> => {
      const client = await svc.gatewayClient(mailbox.id);
      const folders = await client.listFolders();
      const sent = folders.find((f) => f.attributes?.includes(SENT_ATTRIBUTE));
      // A mailbox whose Sent folder cannot be found is one we cannot read, not one with no history.
      if (!sent) throw namedError('NoSentFolder', 'the mailbox has no Sent folder');
      const inbox = folders.find((f) => f.attributes?.includes(INBOX_ATTRIBUTE))?.id ?? 'INBOX';
      const [sentAll, inboxAll] = await Promise.all([
        foldersMessages(client, sent.id, recipients, limit),
        foldersMessages(client, inbox, recipients, limit),
      ]);
      // any_email also matches the address as a sender, so check the direction ourselves.
      const sentTo = sentAll
        .filter((m) => [...m.to, ...m.cc, ...m.bcc].some((p) => wanted.has(p.email.trim().toLowerCase())))
        .sort((a, b) => b.date - a.date)
        .slice(0, limit);
      const receivedFrom = inboxAll
        .filter((m) => m.from.some((p) => wanted.has(p.email.trim().toLowerCase())))
        .slice(0, limit);
      const newest = sentTo[0];
      return {
        ...base,
        sent_count: sentTo.length,
        last_sent_at: newest ? new Date(newest.date * 1000).toISOString() : null,
        recent_subjects: sentTo.slice(0, MAX_SUBJECTS).map((m) => safeSubject(m.subject)),
        received_count: receivedFrom.length,
      };
    };
    return await withDeadline(compute(), LOOKUP_TIMEOUT_MS);
  } catch (err) {
    // This mailbox is reported unreadable, not as "no history" (SF4). Class and status only.
    log?.warn({ mailboxId: mailbox.id, ...grantSafeErrorFields(err), label: errorLabel(err) }, 'mailbox evidence: a mailbox could not be read');
    return { ...base, error: errorLabel(err) };
  }
}

/** Per-mailbox history with the recipients, for every live mailbox. Never throws on one mailbox. */
export async function mailboxEvidence(
  svc: Pick<SkillPrincipalMailboxes, 'list' | 'gatewayClient'>,
  recipients: string[],
  opts: { limit?: number; log?: Pick<Logger, 'warn'> } = {},
): Promise<MailboxEvidence[]> {
  const normalized = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter((r) => r !== ''))].slice(0, MAX_RECIPIENTS);
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);
  const mailboxes = await svc.list();
  return Promise.all(mailboxes.map((m) => one(svc, m, normalized, limit, opts.log)));
}

/**
 * What the calendar path gets (#2475, R81): counts and the domain match only. Subjects and dates
 * of the principal's mail stay out of calendar tool results, which other agents can read.
 */
export type CountsOnlyEvidence = Omit<MailboxEvidence, 'recent_subjects' | 'last_sent_at'>;

/** Strip an evidence row to counts and the domain match. */
export function countsOnly(e: MailboxEvidence): CountsOnlyEvidence {
  const { mailbox, mailbox_label, sent_count, received_count, domain_match, error } = e;
  return { mailbox, mailbox_label, sent_count, received_count, domain_match, ...(error !== undefined ? { error } : {}) };
}

type Scored = Pick<MailboxEvidence, 'mailbox' | 'sent_count' | 'received_count' | 'domain_match' | 'error'>;

function score(e: Scored): number {
  return e.sent_count * 2 + e.received_count + (e.domain_match ? 5 : 0);
}

/** How the evidence relates to the mailbox the compose is about to use. */
export function classifyEvidence(e: Scored[], chosen: string): EvidenceVerdict {
  // An account we could not read is not "no history": the verdict cannot be agrees or none.
  // Never tell the model to lean away from an account we could not read.
  if (e.find((x) => x.mailbox === chosen)?.error !== undefined) return 'split';
  const unreadable = e.some((x) => x.error !== undefined);
  const scores = e.map((x) => ({ id: x.mailbox, s: score(x) }));
  if (scores.every((x) => x.s <= 0)) return unreadable ? 'split' : 'none';
  const mine = scores.find((x) => x.id === chosen)?.s ?? 0;
  const others = scores.filter((x) => x.id !== chosen).map((x) => x.s);
  if (others.every((s) => s === 0) && mine > 0) return unreadable ? 'split' : 'agrees';
  if (others.some((s) => s > mine)) return 'leans_other';
  return 'split';
}
