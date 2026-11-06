// send-evidence.ts — what the drafting turn actually looked up (#2159, spec "The judge's brief").
//
// Read back from audit_log: the agent.task row (what the turn was answering, and its bound
// task's progress) and the tool.result rows of its tool calls (task → tool.invoke →
// tool.result; AuditLogRepo.findToolResultsForTasks) and the principal.report rows the turn
// filed (what it told the principal; findPrincipalReportsForTasks, #2312). The judge checks claims about the
// principal against this; it is passed beside the message and never written into it.
//
// Authority (#2312): who directed the work — the turn's stamped originator, its live-turn
// signal, and the task it was bound to with that task's project root, read from the tasks
// table. Later code decides what that authority covers; here each piece is validated and a
// malformed or missing one reads as null/absent, never as more authority. A reply linked to
// Curia's outreach also carries the linked task (the dispatcher's `linkedTask`), with its
// task's originator, or for a task-less link the outreach row's.
//
// Decisions (#2312): the principal's latest yes or no on a personal-data ask, for the send's
// conversation and non-principal recipients (disclosure_decisions). Code only, like the link's
// outreach id: band review renders them for the judge without the recipient identifiers.
//
// Credentials are redacted before the evidence leaves for the judge's model provider, which
// may differ from the agents'. Contact data is not: grounding checks claims such as "Dana's
// number is …" against exactly that.
//
// Timing: the bus's audit write-ahead hook runs before publish() resolves (bus.ts onEvent),
// so every tool result a turn produced before it called a send skill is already in
// audit_log when the gateway asks.

import type { AuditLogRepo } from '../audit/audit-log-repo.js';
import { isLiveTurnGrantActive } from './live-turn-grants.js';
import type { ContactTier, SystemRole } from '../contacts/types.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { OutreachLinkKind } from '../dispatch/outreach-matcher.js';
import type { TaskOutreachRepo } from '../dispatch/task-outreach.js';
import type { Logger } from '../logger.js';
import { createSecretPatterns } from '../security/secret-patterns.js';
import type { BriefEvidence, SendAuthority } from './judge-brief.js';
import type { DisclosureDecisionRow, DisclosureDecisionsRepo } from './disclosure-decisions.js';

export type { SendAuthority } from './judge-brief.js';

export const EVIDENCE_RESULT_MAX_CHARS = 2_000;
export const EVIDENCE_TOTAL_MAX_CHARS = 12_000;
// A turn rarely makes more than a few dozen calls; the repo returns the newest first, so a
// cut keeps the lookups closest to the send.
const RESULTS_LIMIT = 60;
const REPORTS_LIMIT = 10;

export interface CollectedEvidence extends BriefEvidence {
  /** True when the audit lookup failed: grounding cannot be judged, so the caller treats it as a judge failure. */
  unavailable: boolean;
  /** Who directed the work. Always present; no authority at all when the evidence is unavailable. */
  authority: SendAuthority;
  /** The principal's latest yes or no per (recipient, label) on this conversation (#2312). Code only. */
  decisions?: DisclosureDecisionRow[];
  /** The outreach row the drafting turn was linked to (#2312): a yes learns the requester onto it. Code only. */
  linkedOutreachId?: string;
}

/** Which thread and recipients a send's decisions are read for (#2312). */
export interface DecisionScope {
  conversationId?: string;
  /** The send's non-principal recipients. */
  counterparties?: readonly string[];
}

type AuthorityOriginator = SendAuthority['originator'];
type AuthorityTask = NonNullable<SendAuthority['boundTask']>;
type AuthorityLink = NonNullable<SendAuthority['linkedTask']>;

/** No originator and no live turn: what an unreadable turn is authorized by. */
const NO_AUTHORITY: SendAuthority = { originator: null, liveTurn: false };

// Keyed by the unions, so a value added to or removed from either fails compilation here.
const SYSTEM_ROLES: ReadonlySet<string> = new Set(Object.keys({ principal: true, agent: true, system: true } satisfies Record<SystemRole, true>));
const CONTACT_TIERS: ReadonlySet<string> = new Set(Object.keys({
  blocked: true, unknown: true, known: true, trusted: true, principal: true,
} satisfies Record<ContactTier, true>));
const LINK_KINDS: ReadonlySet<string> = new Set(Object.keys({
  address: true, contact: true, 'org-domain': true, inferred: true,
} satisfies Record<OutreachLinkKind, true>));
const LINK_STRENGTHS: ReadonlySet<string> = new Set(Object.keys({ strong: true, weak: true } satisfies Record<AuthorityLink['strength'], true>));

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Replace credential-shaped substrings (API keys, bearer tokens, long hex) with [REDACTED]. */
function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of createSecretPatterns()) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function renderResult(payload: Record<string, unknown>): string {
  try {
    return redactSecrets(JSON.stringify(payload['result']) ?? '');
  } catch (err) {
    // A circular structure cannot reach audit_log as JSONB, so this is defensive only.
    return `[unrenderable result: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/** A report to the principal as the judge sees it: credentials redacted, trimmed like other evidence. */
export function reportEvidence(text: string): string {
  return clip(redactSecrets(text), EVIDENCE_RESULT_MAX_CHARS);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * An originator as authority evidence. Originators reach here as JSONB (audit_log metadata,
 * tasks.originator), so the shape is checked rather than trusted: anything malformed is null.
 * A missing tier (stamped before #950) is null; `authenticated` counts only when exactly true.
 */
function readOriginator(raw: unknown): AuthorityOriginator {
  if (!isRecord(raw)) return null;
  const { contactId, systemRole, tier, channel, authenticated } = raw;
  if (typeof contactId !== 'string' || typeof channel !== 'string') return null;
  if (systemRole !== null && !(typeof systemRole === 'string' && SYSTEM_ROLES.has(systemRole))) return null;
  if (tier !== undefined && tier !== null && !(typeof tier === 'string' && CONTACT_TIERS.has(tier))) return null;
  return {
    contactId,
    // Checked against the sets above.
    systemRole: systemRole as SystemRole | null,
    tier: (tier ?? null) as ContactTier | null,
    channel,
    authenticated: authenticated === true,
  };
}

/**
 * The dispatcher's `linkedTask` stamp, checked like an originator: a missing or empty
 * outreachId, a taskId that is neither a non-empty string nor null, or a linkKind or strength
 * outside its set makes the whole link absent. Never a weaker reading of a malformed one.
 */
function readLink(raw: unknown): { taskId: string | null; outreachId: string; linkKind: OutreachLinkKind; strength: AuthorityLink['strength'] } | null {
  if (!isRecord(raw)) return null;
  const { taskId, outreachId, linkKind, strength } = raw;
  if (typeof outreachId !== 'string' || outreachId === '') return null;
  if (taskId !== null && !(typeof taskId === 'string' && taskId !== '')) return null;
  if (typeof linkKind !== 'string' || !LINK_KINDS.has(linkKind)) return null;
  if (typeof strength !== 'string' || !LINK_STRENGTHS.has(strength)) return null;
  // Checked against the sets above.
  return { taskId, outreachId, linkKind: linkKind as OutreachLinkKind, strength: strength as AuthorityLink['strength'] };
}

function lowerStrings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.map((x: string) => x.trim().toLowerCase()) : null;
}

/** An outreach row's counterparties, lowercased; any ill-typed list drops them all. */
function readCounterparty(row: { addresses: unknown; contactIds: unknown; domains: unknown }): AuthorityLink['counterparty'] {
  const addresses = lowerStrings(row.addresses);
  const contactIds = lowerStrings(row.contactIds);
  const domains = lowerStrings(row.domains);
  return addresses && contactIds && domains ? { addresses, contactIds, domains } : undefined;
}

/** Task text for the judge: credentials redacted, trimmed like other evidence. */
function taskText(text: string): string {
  return clip(redactSecrets(text), EVIDENCE_RESULT_MAX_CHARS);
}

export class SendEvidenceCollector {
  constructor(private readonly deps: {
    auditLogRepo: Pick<AuditLogRepo, 'findById' | 'findToolResultsForTasks' | 'findPrincipalReportsForTasks'>;
    /** Reads the bound task and its project root for authority (#2312). */
    taskRepo: Pick<TaskRepo, 'getTask' | 'resolveProjectRootTaskId'>;
    /** Reads a link's outreach row: its counterparties, and a task-less link's originator (#2312). Absent: a link has neither. */
    taskOutreachRepo?: Pick<TaskOutreachRepo, 'getById'>;
    /** Reads the principal's earlier yes or no on this thread (#2312). Absent: no decisions. */
    disclosureDecisionsRepo?: Pick<DisclosureDecisionsRepo, 'latestFor'>;
    /** The injected "## Who you serve" block, read per call so identity hot-reloads (#1514) apply. */
    principalBlock: () => string | null;
    logger: Logger;
  }) {}

  /**
   * Evidence from one or more drafting turns, newest tool result first. `scope` names the
   * send's conversation and non-principal recipients, for the principal's decisions there.
   */
  async collect(taskEventIds: readonly string[], scope: DecisionScope = {}): Promise<CollectedEvidence> {
    const principalBlock = this.deps.principalBlock();
    if (taskEventIds.length === 0) {
      // A send with no drafting turn to read (no taskEventId). The caller treats this as a
      // judge failure; the warning says why, since nothing else will.
      this.deps.logger.warn('send-evidence: no drafting turn to read — grounding cannot be judged');
      return { unavailable: true, toolResults: [], principalBlock, authority: NO_AUTHORITY };
    }
    try {
      // The latest turn's task row describes what the message answers.
      const latest = taskEventIds[taskEventIds.length - 1]!;
      const task = await this.deps.auditLogRepo.findById(latest);
      if (task === null) {
        // Without it the purpose question has nothing to go on but the outbound message,
        // which leans toward "serving" — so this is a failure, not thin evidence.
        this.deps.logger.warn({ taskEventIds }, 'send-evidence: drafting turn not found in audit_log — grounding cannot be judged');
        return { unavailable: true, toolResults: [], principalBlock, authority: NO_AUTHORITY };
      }
      const content = task.payload['content'];
      const metadata = task.payload['metadata'];
      const boundTask = isRecord(metadata) ? metadata['boundTask'] : undefined;
      const progress = isRecord(boundTask) ? boundTask['progress'] : undefined;
      const boundTaskId = isRecord(boundTask) && typeof boundTask['taskId'] === 'string' ? boundTask['taskId'] : undefined;
      const link = readLink(isRecord(metadata) ? metadata['linkedTask'] : undefined);

      const results = await this.deps.auditLogRepo.findToolResultsForTasks(taskEventIds, RESULTS_LIMIT);
      if (results.length === RESULTS_LIMIT) {
        this.deps.logger.info({ taskEventIds, limit: RESULTS_LIMIT }, 'send-evidence: result limit reached — older lookups left out');
      }

      const toolResults: Array<{ toolName: string; result: string }> = [];
      let total = 0;
      for (const r of results) {
        const toolName = String(r.payload['toolName'] ?? r.payload['skillName'] ?? 'unknown');
        const text = clip(renderResult(r.payload), EVIDENCE_RESULT_MAX_CHARS);
        // Newest first, so the budget keeps the lookups closest to the send.
        if (total + text.length > EVIDENCE_TOTAL_MAX_CHARS) break;
        total += text.length;
        toolResults.push({ toolName, result: text });
      }

      // What the turn told the principal supports "I've passed that on" (#2312). A throw here
      // lands in the catch below: the same unavailable evidence as a failed tool-result read.
      const reportRows = await this.deps.auditLogRepo.findPrincipalReportsForTasks(taskEventIds, REPORTS_LIMIT);
      const reportsToPrincipal = reportRows
        .map((r) => r.payload['summary'])
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .map(reportEvidence);

      const grantId = task.payload['liveTurnGrantId'];
      const authority: SendAuthority = {
        originator: readOriginator(isRecord(metadata) ? metadata['originator'] : undefined),
        // The dispatcher's distinct top-level signal (#1126); only an exact true counts. A voice
        // hand-off's liveTurn counts only while its grant is active (#2495).
        liveTurn: task.payload['liveTurn'] === true
          && (grantId === undefined || isLiveTurnGrantActive(typeof grantId === 'string' ? grantId : undefined)),
        ...(boundTaskId !== undefined ? await this.readTasks(boundTaskId) : {}),
        ...(link !== null ? { linkedTask: await this.readLinkedTask(link) } : {}),
      };

      const decisions = await this.readDecisions(scope);

      return {
        unavailable: false,
        authority,
        ...(link !== null ? { linkedOutreachId: link.outreachId } : {}),
        ...(decisions ? { decisions } : {}),
        ...(reportsToPrincipal.length > 0 ? { reportsToPrincipal } : {}),
        ...(typeof content === 'string' ? { taskContent: clip(redactSecrets(content), EVIDENCE_RESULT_MAX_CHARS) } : {}),
        ...(progress !== undefined ? { taskProgress: clip(redactSecrets(JSON.stringify(progress)), EVIDENCE_RESULT_MAX_CHARS) } : {}),
        toolResults,
        principalBlock,
      };
    } catch (err) {
      this.deps.logger.error({ err, taskEventIds }, 'send-evidence: audit lookup failed — grounding cannot be judged');
      return { unavailable: true, toolResults: [], principalBlock, authority: NO_AUTHORITY };
    }
  }

  /**
   * The principal's latest decisions for this thread's recipients. A failed read is logged and
   * leaves them out rather than marking the evidence unavailable: without a yes the send is
   * reviewed as if never asked, and without a no the principal may be asked again. Neither
   * shares anything.
   */
  private async readDecisions(scope: DecisionScope): Promise<DisclosureDecisionRow[] | undefined> {
    const { conversationId, counterparties } = scope;
    if (!this.deps.disclosureDecisionsRepo || !conversationId || !counterparties || counterparties.length === 0) return undefined;
    try {
      return await this.deps.disclosureDecisionsRepo.latestFor(conversationId, counterparties);
    } catch (err) {
      this.deps.logger.error({ err, conversationId }, 'send-evidence: could not read the principal\'s disclosure decisions — reviewing without them');
      return undefined;
    }
  }

  /**
   * The bound task and, when different, its project root. A task-repo failure is logged and
   * leaves the failed part out rather than marking the evidence unavailable: authority then
   * rests on the originator alone, which only narrows what can be authorized.
   */
  private async readTasks(boundTaskId: string): Promise<Pick<SendAuthority, 'boundTask' | 'rootTask'>> {
    let bound: AuthorityTask | undefined;
    try {
      bound = await this.readTask(boundTaskId);
    } catch (err) {
      this.deps.logger.error({ err, taskId: boundTaskId }, 'send-evidence: bound task lookup failed — authority rests on the originator alone');
      return {};
    }
    if (bound === undefined) {
      this.deps.logger.warn({ taskId: boundTaskId }, 'send-evidence: bound task not found — authority rests on the originator alone');
      return {};
    }
    try {
      const rootId = await this.deps.taskRepo.resolveProjectRootTaskId(boundTaskId);
      if (rootId === null || rootId === boundTaskId) return { boundTask: bound };
      const root = await this.readTask(rootId);
      return root === undefined ? { boundTask: bound } : { boundTask: bound, rootTask: root };
    } catch (err) {
      this.deps.logger.error({ err, taskId: boundTaskId }, 'send-evidence: root task lookup failed — authority leaves the root out');
      return { boundTask: bound };
    }
  }

  /**
   * The linked task's title, originator and project root (the task's own, or for a task-less
   * link the outreach row's originator), and the row's counterparties. A failed or missing read
   * leaves that part out: no originator gives the link no authority and no askability, and no
   * counterparties means no recipient matches it.
   */
  private async readLinkedTask(link: NonNullable<ReturnType<typeof readLink>>): Promise<AuthorityLink> {
    const { taskId, outreachId, linkKind, strength } = link;
    const row = await this.readLinkRow(taskId, outreachId);
    let title: string | null = null;
    let originator: AuthorityOriginator = taskId === null ? row?.originator ?? null : null;
    let root: AuthorityLink['root'];
    if (taskId !== null) {
      let task: AuthorityTask | undefined;
      try {
        task = await this.readTask(taskId);
        if (task === undefined) this.deps.logger.warn({ taskId, outreachId }, 'send-evidence: linked task not found — the link carries no originator');
      } catch (err) {
        this.deps.logger.error({ err, taskId, outreachId }, 'send-evidence: linked task lookup failed — the link carries no originator');
      }
      if (task !== undefined) {
        title = task.title;
        originator = task.originator;
        root = await this.readLinkRoot(taskId);
      }
    }
    return {
      taskId, title, originator,
      ...(root ? { root } : {}),
      linkKind, strength,
      ...(row?.counterparty ? { counterparty: row.counterparty } : {}),
    };
  }

  /** The linked task's project root when it differs from the task; a failure leaves it out. */
  private async readLinkRoot(taskId: string): Promise<AuthorityLink['root']> {
    try {
      const rootId = await this.deps.taskRepo.resolveProjectRootTaskId(taskId);
      if (rootId === null || rootId === taskId) return undefined;
      const root = await this.readTask(rootId);
      return root === undefined ? undefined : { taskId: root.taskId, title: root.title, originator: root.originator };
    } catch (err) {
      this.deps.logger.error({ err, taskId }, 'send-evidence: linked task root lookup failed — the link leaves the root out');
      return undefined;
    }
  }

  /** The link's outreach row: its originator and counterparties. Undefined when it cannot be read. */
  private async readLinkRow(
    taskId: string | null,
    outreachId: string,
  ): Promise<{ originator: AuthorityOriginator; counterparty: AuthorityLink['counterparty'] } | undefined> {
    if (!this.deps.taskOutreachRepo) {
      this.deps.logger.warn({ outreachId, taskId }, 'send-evidence: outreach repo not wired — the link carries no counterparties');
      return undefined;
    }
    try {
      const row = await this.deps.taskOutreachRepo.getById(outreachId);
      if (row === null) {
        this.deps.logger.warn({ outreachId, taskId }, 'send-evidence: linked outreach row not found — the link carries no counterparties');
        return undefined;
      }
      return { originator: readOriginator(row.originator), counterparty: readCounterparty(row) };
    } catch (err) {
      this.deps.logger.error({ err, outreachId, taskId }, 'send-evidence: linked outreach row lookup failed — the link carries no counterparties');
      return undefined;
    }
  }

  private async readTask(taskId: string): Promise<AuthorityTask | undefined> {
    const row = await this.deps.taskRepo.getTask(taskId);
    if (row === null) return undefined;
    return {
      taskId: row.id,
      title: taskText(row.title),
      description: row.description === null ? null : taskText(row.description),
      originator: readOriginator(row.originator),
    };
  }
}
