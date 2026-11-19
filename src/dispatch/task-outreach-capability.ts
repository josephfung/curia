// src/dispatch/task-outreach-capability.ts
//
// The tool-facing side of task_outreach (#2312): which turns may record outreach, what a
// row says, and the writers' shared helpers. Three writers use it: every send skill
// (through registerOutboundContext), the record-outreach tool, and the web-browser
// backstop that notices the principal's or Curia's own contact details typed into a form.
//
// A turn is task-bound when it carries a bound task (a wake), a linked task (a reply
// linked to outreach), or is a live principal turn. Only those turns write: outreach an
// outsider steered Curia into must not be able to pull later replies into a task.

import type { Logger } from '../logger.js';
import type { ChannelIdentity, TaskOriginator } from '../contacts/types.js';
import { hasPrincipalAuthority, isLivePrincipalTurn } from '../contacts/principal.js';
import { isNonOrgDomain } from '../contacts/non-org-domains.js';
import { boundTaskFromMetadata } from '../agents/resumable-task.js';
import { registrableDomain } from '../verification/domain.js';
import type { OutreachVia, TaskOutreachRepo, TaskOutreachRow } from './task-outreach.js';
import type { TaskRepo } from '../db/task-repo.js';

/** The slice of a ToolContext the writers read. Structural, so dispatch never imports skills. */
export interface OutreachTurn {
  taskOutreach?: TaskOutreachCapability;
  taskMetadata?: Record<string, unknown>;
  liveTurn?: boolean;
  taskEventId?: string;
  conversationId?: string;
}

export interface OutreachScope {
  taskId: string | null;
  conversationId: string | null;
  directingEventId: string | null;
  originator: TaskOriginator;
}

export interface OutreachEntry {
  via: OutreachVia;
  orgName?: string | null;
  domains?: readonly string[];
  addresses?: readonly string[];
  contactIds?: readonly string[];
  givenContact?: string | null;
  /** Stored as-is, or used as the fallback when `useTaskTitle` finds no task title. */
  summary: string;
  /** Prefer the bound task's title over `summary` (sends and the browser backstop). */
  useTaskTitle?: boolean;
  /** Inferred by the browser backstop rather than an explicit act: always unconfirmed. */
  backstop?: boolean;
}

export interface TaskOutreachCapability {
  /** Record outreach for this turn. Null, with nothing written, when the turn is not task-bound. */
  recordForTurn(turn: OutreachTurn, entry: OutreachEntry): Promise<TaskOutreachRow | null>;
  /**
   * The principal's or Curia's own email address or phone number that `text` is, or null.
   * Emails compare case-insensitively; phones by digits, with or without a leading 1.
   */
  ownIdentity(text: string): string | null;
  /** True for the principal's contact id. */
  isPrincipalContact(contactId: string): boolean;
  /** The principal's own domains (TaskOutreachServiceDeps.nonOrgDomains), for orgDomainsOf. */
  readonly nonOrgDomains?: ReadonlySet<string>;
}

/** Cap on an email subject used as a send's summary, when there is no task title. */
export const SEND_SUMMARY_MAX_CHARS = 120;

const CHANNEL_LABELS: Readonly<Record<OutreachVia, string>> = {
  email: 'Email', web_form: 'Web form', signal: 'Signal', sms: 'SMS', slack: 'Slack', phone: 'Phone', other: 'Other',
};

/**
 * A send's summary when the turn has no task title: the email subject, else a label. Never
 * the message body: a row's summary is shown to the matcher's model and on the link block,
 * and the body can carry the very details the band judge is guarding (#2312).
 */
export function sendSummaryFallback(via: OutreachVia, subject: string | undefined, domains: readonly string[]): string {
  const trimmed = subject?.trim() ?? '';
  if (trimmed !== '') return trimmed.slice(0, SEND_SUMMARY_MAX_CHARS);
  if (via === 'email') return `Email to ${domains[0] ?? 'a contact'}`;
  return `${CHANNEL_LABELS[via]} message`;
}

/**
 * The task a strongly linked reply belongs to. A weak link binds nothing (#2312): an unverified
 * sender's turn must not widen that task's outreach with addresses or domains of its choosing.
 */
function linkedTaskId(metadata: Record<string, unknown> | undefined): string | null {
  const linked = metadata?.['linkedTask'];
  if (!linked || typeof linked !== 'object' || Array.isArray(linked)) return null;
  if ((linked as Record<string, unknown>)['strength'] !== 'strong') return null;
  const taskId = (linked as Record<string, unknown>)['taskId'];
  return typeof taskId === 'string' && taskId !== '' ? taskId : null;
}

/** Where this turn's outreach belongs, or null when the turn may not record outreach. */
export function outreachScope(turn: OutreachTurn): OutreachScope | null {
  const metadata = turn.taskMetadata;
  // Runtime-checked below; cast through unknown per repo policy.
  const originator = metadata?.['originator'] as unknown as TaskOriginator | undefined;
  if (!originator || typeof originator !== 'object') return null;
  const conversationId = turn.conversationId ?? null;
  const directingEventId = turn.taskEventId ?? null;

  const taskId = boundTaskFromMetadata(metadata)?.taskId ?? linkedTaskId(metadata);
  if (taskId) return { taskId, conversationId, directingEventId, originator };

  // No task: only the principal, live, may direct outreach. The row is scoped to the
  // conversation so the reply can still find it.
  if (isLivePrincipalTurn(turn.liveTurn, metadata) && conversationId) {
    return { taskId: null, conversationId, directingEventId, originator };
  }
  return null;
}

const PHONE_SHAPED = /^\+?[\d\s().-]+$/;

function phoneDigits(value: string): string | null {
  const trimmed = value.trim();
  if (!PHONE_SHAPED.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

/** Same number, allowing a NANP form typed without its leading country code 1. */
function samePhone(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.length === short.length + 1 && long.startsWith('1') && long.endsWith(short);
}

export interface TaskOutreachServiceDeps {
  /** Live list: the bootstrap hot-reloads the principal's identities in place. */
  principalIdentities: readonly ChannelIdentity[];
  /** Curia's own mailboxes. */
  selfEmails: readonly string[];
  /** Curia's own numbers (Signal account, SMS sender). */
  selfPhones?: readonly string[];
  /** The task's title and project root, for the row. Null when unknown. */
  lookupTask?: (taskId: string) => Promise<{ title: string; rootTaskId: string | null } | null>;
  /**
   * Domains never stored as an outreach org domain beyond the built-in lists: the
   * principal's own (`principalOrgDomainSet`). The matcher is given the same set.
   */
  nonOrgDomains?: ReadonlySet<string>;
  log: Logger;
}

export class TaskOutreachService implements TaskOutreachCapability {
  constructor(
    private readonly repo: Pick<TaskOutreachRepo, 'record'>,
    private readonly deps: TaskOutreachServiceDeps,
  ) {}

  async recordForTurn(turn: OutreachTurn, entry: OutreachEntry): Promise<TaskOutreachRow | null> {
    const scope = outreachScope(turn);
    if (!scope) return null;

    let summary = entry.summary;
    let rootTaskId: string | null = null;
    if (scope.taskId && this.deps.lookupTask) {
      try {
        const task = await this.deps.lookupTask(scope.taskId);
        rootTaskId = task?.rootTaskId ?? null;
        if (entry.useTaskTitle && task?.title) summary = task.title;
      } catch (err) {
        // The row is still worth writing: the title only labels it.
        this.deps.log.warn({ err, taskId: scope.taskId }, 'task-outreach: task lookup failed — recording without its title');
      }
    }

    return this.repo.record({
      taskId: scope.taskId,
      rootTaskId,
      conversationId: scope.conversationId,
      directingEventId: scope.directingEventId,
      originator: scope.originator,
      via: entry.via,
      orgName: entry.orgName ?? null,
      // Compared as principalOrgDomainSet normalizes: trimmed, lowercased, no trailing dot.
      domains: (entry.domains ?? []).filter((d) => !this.deps.nonOrgDomains?.has(d.trim().toLowerCase().replace(/\.$/, ''))),
      addresses: [...(entry.addresses ?? [])],
      contactIds: [...(entry.contactIds ?? [])],
      givenContact: entry.givenContact ?? null,
      summary,
      // Confirmed only for an explicit act the principal directed (#2312). Task 3 links an
      // unconfirmed row weakly, so a backstop guess or an outsider-steered turn adds no authority.
      // A forged From or spoofed SMS number is not the principal directing it (GHSA-p49r-jqh2-v668).
      confirmed: entry.backstop !== true && hasPrincipalAuthority(scope.originator),
    });
  }

  ownIdentity(text: string): string | null {
    const value = text.trim().toLowerCase();
    if (value === '') return null;
    const typedPhone = phoneDigits(value);
    const candidates = [
      ...this.deps.principalIdentities.map((i) => i.channelIdentifier),
      ...this.deps.selfEmails,
      ...(this.deps.selfPhones ?? []),
    ];
    for (const candidate of candidates) {
      const own = candidate.trim().toLowerCase();
      if (own === '') continue;
      if (own === value) return own;
      if (typedPhone) {
        const ownPhone = phoneDigits(own);
        if (ownPhone && samePhone(typedPhone, ownPhone)) return own;
      }
    }
    return null;
  }

  isPrincipalContact(contactId: string): boolean {
    return this.deps.principalIdentities.some((i) => i.contactId === contactId);
  }

  get nonOrgDomains(): ReadonlySet<string> | undefined {
    return this.deps.nonOrgDomains;
  }
}

/** Task title and project root from the task repo, for TaskOutreachServiceDeps.lookupTask. */
export function taskLookupFrom(
  taskRepo: Pick<TaskRepo, 'getTask' | 'resolveProjectRootTaskId'>,
): NonNullable<TaskOutreachServiceDeps['lookupTask']> {
  return async (taskId) => {
    const task = await taskRepo.getTask(taskId);
    if (!task) return null;
    return { title: task.title, rootTaskId: await taskRepo.resolveProjectRootTaskId(taskId) };
  };
}

/**
 * Registrable domains of the email addresses among `addresses`, minus webmail, form hosts,
 * shared tenant hosts and private-suffix hosts, and minus `exclude` (the principal's own
 * domains) by registrable domain or full host. The full host is checked, since a private
 * suffix (acme.github.io) is only visible there.
 */
export function orgDomainsOf(addresses: readonly string[], exclude: ReadonlySet<string> = new Set()): string[] {
  const domains = new Set<string>();
  for (const address of addresses) {
    const at = address.lastIndexOf('@');
    if (at < 0) continue;
    const host = address.slice(at + 1);
    const domain = registrableDomain(host);
    if (domain && !isNonOrgDomain(host) && !exclude.has(domain) && !exclude.has(host.toLowerCase())) domains.add(domain);
  }
  return [...domains];
}

/** What a send skill hands registerOutboundContext so the send leaves an outreach row. */
export interface SendOutreach {
  turn: OutreachTurn;
  via: OutreachVia;
  /** The resolved recipient identifiers (email addresses, phone numbers, Slack ids). */
  addresses: readonly string[];
  /** The email's subject, the summary when the turn has no task title. */
  subject?: string;
}

/**
 * Record a delivered send as task outreach. Best-effort: the message already went out,
 * so a failure is logged and never reaches the skill. The principal and Curia's own
 * addresses are left out; a send to no one else writes nothing.
 */
export async function recordSendOutreach(
  outreach: SendOutreach,
  sent: { recipientContactIds?: readonly string[]; log: Logger },
): Promise<void> {
  const capability = outreach.turn.taskOutreach;
  if (!capability) return;
  try {
    const addresses = outreach.addresses
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a !== '' && capability.ownIdentity(a) === null);
    const contactIds = (sent.recipientContactIds ?? []).filter((id) => !capability.isPrincipalContact(id));
    if (addresses.length === 0 && contactIds.length === 0) return;
    // The principal's domains are excluded here too, where a full host (mail.corp.example)
    // is still visible; recordForTurn sees only the reduced org domain.
    const domains = outreach.via === 'email' ? orgDomainsOf(addresses, capability.nonOrgDomains) : [];
    const row = await capability.recordForTurn(outreach.turn, {
      via: outreach.via,
      addresses,
      contactIds,
      domains,
      // The task title when there is one (useTaskTitle); never the message body.
      summary: sendSummaryFallback(outreach.via, outreach.subject, domains),
      useTaskTitle: true,
    });
    if (row) sent.log.debug({ outreachId: row.id, taskId: row.taskId, via: row.via }, 'task-outreach: recorded send');
  } catch (err) {
    sent.log.warn({ err, via: outreach.via }, 'task-outreach: failed to record send — a reply may not find its task');
  }
}
