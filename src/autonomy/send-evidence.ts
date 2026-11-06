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
// Delegation (#2499): a delegated specialist's task row holds the coordinator's rewritten
// brief, which reads like clean principal work whatever the person asked. When the turn
// carries `delegationOrigin`, the walk follows `delegationOrigin.taskEventId` back to the root
// task (the turn that was not itself delegated). Beside the delegate's brief it passes what
// started that task: for an inbound turn, the `inbound.message` the dispatcher parented it on
// (the sender's text before any preamble) plus any follow-ups a turn lane drained into it; for
// any other root, the root task's content. With either, up to five earlier inbound messages
// from the same sender on that conversation, newest first, so a push made in an earlier email
// still reaches the judge when the message that started the work is bland. A chain that
// cannot be followed to its root, or an
// inbound that cannot be read, makes the evidence unavailable and flags `originUnresolved`:
// the purpose check would otherwise judge the brief.
//
// Credentials are redacted before the evidence leaves for the judge's model provider, which
// may differ from the agents'. Contact data is not: grounding checks claims such as "Dana's
// number is …" against exactly that.
//
// Timing: the bus's audit write-ahead hook runs before publish() resolves (bus.ts onEvent),
// so every tool result a turn produced before it called a send skill is already in
// audit_log when the gateway asks.

import type { AuditLogRepo, AuditLogRow } from '../audit/audit-log-repo.js';
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
/**
 * What started a delegation chain (#2499): the root inbound and its drained follow-ups. Larger
 * than one tool result, and trimmed from the middle so both the opening and the latest
 * follow-up survive. It counts against EVIDENCE_TOTAL_MAX_CHARS, so it is kept first and the
 * tool results get the rest.
 */
export const EVIDENCE_ORIGIN_MAX_CHARS = 4_000;
/**
 * Earlier inbound messages from the root's sender on its conversation (#2499): a push in an
 * earlier email, with a bland message that started the work. Newest first; each trimmed from
 * the middle, all inside EVIDENCE_HISTORY_MAX_CHARS, behind the origin and ahead of the tool
 * results in the budget.
 */
export const SENDER_HISTORY_LIMIT = 5;
export const EVIDENCE_HISTORY_ITEM_MAX_CHARS = 1_200;
export const EVIDENCE_HISTORY_MAX_CHARS = 3_000;
/** Follow-ups a turn lane drained into the root turn, newest kept (#2499). */
export const ORIGIN_FOLLOW_UPS_LIMIT = 5;
/** Between the root inbound and each follow-up in the origin text. */
export const FOLLOW_UP_SEPARATOR = '\n\n[Follow-up the sender sent while the assistant was working on the message above]\n\n';
/**
 * Delegation hops followed to the root. The coordinator is the only caller of `delegate`, so
 * a real chain is one hop; the bound stops a malformed or cyclic chain. Longer is a failure.
 */
export const DELEGATION_MAX_HOPS = 4;
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
  /**
   * Set with `unavailable` when a delegated turn's origin could not be followed or read
   * (#2499), as opposed to a failed read. The send review holds rather than failing open.
   */
  originUnresolved?: true;
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

/**
 * Trim from the middle, saying how much was left out, so text padded at the front or the back
 * cannot push the other end out of view (#2499). The result is at most `max` characters
 * whenever `max` is longer than the marker (about 40); below that, only the marker is left.
 */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (n: number): string => `\n[… ${n} characters left out …]\n`;
  // The marker's length depends on the count; size it for the worst case.
  const keep = Math.max(0, max - marker(text.length).length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}${marker(text.length - keep)}${text.slice(text.length - tail)}`;
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

/** The delegation chain's root task, or why it could not be followed. */
type DelegationRoot =
  | { ok: true; root: AuditLogRow | null }
  | { ok: false; reason: string };

/** What started the chain, as the judge sees it, or why it could not be read. */
type OriginRead =
  | { ok: true; content: string; kind: 'inbound' | 'task'; at: string; history: Array<{ at: string; text: string }> }
  | { ok: false; reason: string };

export class SendEvidenceCollector {
  constructor(private readonly deps: {
    auditLogRepo: Pick<AuditLogRepo, 'findById' | 'findToolResultsForTasks' | 'findPrincipalReportsForTasks' | 'findInjectedInboundIds' | 'findRecentInboundsFromSender'>;
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

      // A delegated turn: what started the chain, in its sender's words (#2499).
      const delegation = await this.readDelegationRoot(task);
      const origin: OriginRead | null = !delegation.ok
        ? delegation
        : delegation.root === null ? null : await this.readOrigin(delegation.root);
      if (origin !== null && !origin.ok) {
        this.deps.logger.warn(
          { taskEventIds, reason: origin.reason },
          'send-evidence: delegated turn\'s origin cannot be followed or read — purpose cannot be judged',
        );
        return { unavailable: true, originUnresolved: true, toolResults: [], principalBlock, authority: NO_AUTHORITY };
      }
      const originContent = origin?.content;
      const historyChars = origin?.history.reduce((n, h) => n + h.text.length, 0) ?? 0;
      // The origin is kept first, then the sender's earlier messages; the tool results share
      // what is left of the budget.
      const resultsBudget = EVIDENCE_TOTAL_MAX_CHARS - (originContent?.length ?? 0) - historyChars;

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
        if (total + text.length > resultsBudget) break;
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

      const authority: SendAuthority = {
        originator: readOriginator(isRecord(metadata) ? metadata['originator'] : undefined),
        // The dispatcher's distinct top-level signal (#1126); only an exact true counts.
        liveTurn: task.payload['liveTurn'] === true,
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
        ...(origin ? { originContent: origin.content, originKind: origin.kind, originAt: origin.at } : {}),
        ...(origin && origin.history.length > 0 ? { senderHistory: origin.history } : {}),
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
   * Follow `delegationOrigin.taskEventId` from a delegated turn back to the root task: the
   * first one that was not itself delegated. `root` is null for a turn that was not delegated.
   * A malformed origin, a missing id, an unreadable or non-task row, a cycle, or a chain past
   * DELEGATION_MAX_HOPS is a failure, never a shorter walk. Read errors propagate to collect()'s
   * catch, which marks the evidence unavailable too.
   *
   * `delegationOrigin` is trusted structure: the dispatcher strips it from channel metadata,
   * and only the delegate skill stamps it (#1860, ADR-045).
   */
  private async readDelegationRoot(task: AuditLogRow): Promise<DelegationRoot> {
    const seen = new Set<string>([task.id]);
    let current = task;
    for (let hops = 0; ; hops++) {
      const metadata = current.payload['metadata'];
      const origin = isRecord(metadata) ? metadata['delegationOrigin'] : undefined;
      // Absent (or null, as isDelegatedSpecialistTask reads it): this task was not delegated.
      if (origin === undefined || origin === null) return { ok: true, root: hops === 0 ? null : current };
      if (!isRecord(origin)) return { ok: false, reason: 'malformed delegationOrigin' };
      if (hops >= DELEGATION_MAX_HOPS) return { ok: false, reason: `chain longer than ${DELEGATION_MAX_HOPS} hops` };
      const parentId = origin['taskEventId'];
      if (typeof parentId !== 'string' || parentId === '') return { ok: false, reason: 'delegationOrigin has no taskEventId' };
      if (seen.has(parentId)) return { ok: false, reason: 'delegation chain loops' };
      seen.add(parentId);
      const parent = await this.deps.auditLogRepo.findById(parentId);
      if (parent === null) return { ok: false, reason: 'origin task not found in audit_log' };
      if (parent.eventType !== 'agent.task') return { ok: false, reason: 'origin row is not an agent.task' };
      current = parent;
    }
  }

  /**
   * What started the root task. For an inbound turn (its parent row is the `inbound.message`
   * the dispatcher published) that is the sender's text as received, before the dispatcher's
   * preambles, then the follow-ups a turn lane drained into the turn, oldest first. Any other
   * root (a scheduled job, a wake, a parent no longer in audit_log) gives its task content,
   * labelled as such. Redacted, then trimmed from the middle. Either way, the sender's earlier
   * messages on the conversation come with it (readSenderHistory). A root with no content, or
   * a drained follow-up whose inbound cannot be read, is a failure.
   */
  private async readOrigin(root: AuditLogRow): Promise<OriginRead> {
    const parent = root.parentEventId ? await this.deps.auditLogRepo.findById(root.parentEventId) : null;
    if (parent === null || parent.eventType !== 'inbound.message') {
      const content = root.payload['content'];
      if (typeof content !== 'string') return { ok: false, reason: 'root task has no content' };
      // A wake or other system-started root (late delegation keeps the origin's conversation
      // and sender): the sender's recent messages there, when the task names a sender.
      const history = await this.readSenderHistory(root.conversationId, root.payload['senderId'], root.timestamp, new Set());
      return {
        ok: true, kind: 'task', at: root.timestamp.toISOString(), history,
        content: clipMiddle(redactSecrets(content), EVIDENCE_ORIGIN_MAX_CHARS),
      };
    }
    const first = parent.payload['content'];
    if (typeof first !== 'string') return { ok: false, reason: 'root inbound has no content' };
    const texts = [first];
    const used = new Set<string>([parent.id]);
    if (root.conversationId !== null) {
      // Turn lanes inject only the host turn's own sender (turn-lanes.ts), so these are that
      // sender's words too. Newest first from the repo, so a cut keeps the latest push; read
      // back oldest first.
      const ids = await this.deps.auditLogRepo.findInjectedInboundIds(root.conversationId, root.id, ORIGIN_FOLLOW_UPS_LIMIT);
      if (ids.length === ORIGIN_FOLLOW_UPS_LIMIT) {
        this.deps.logger.info({ rootTaskEventId: root.id, limit: ORIGIN_FOLLOW_UPS_LIMIT }, 'send-evidence: follow-up limit reached — older follow-ups left out');
      }
      for (const id of [...ids].reverse()) {
        const row = await this.deps.auditLogRepo.findById(id);
        const text = row?.eventType === 'inbound.message' ? row.payload['content'] : undefined;
        if (typeof text !== 'string') return { ok: false, reason: 'a follow-up drained into the root turn cannot be read' };
        texts.push(text);
        used.add(id);
      }
    }
    const history = await this.readSenderHistory(parent.conversationId ?? root.conversationId, parent.payload['senderId'], parent.timestamp, used);
    return {
      ok: true, kind: 'inbound', at: parent.timestamp.toISOString(), history,
      content: clipMiddle(redactSecrets(texts.join(FOLLOW_UP_SEPARATOR)), EVIDENCE_ORIGIN_MAX_CHARS),
    };
  }

  /**
   * The sender's inbound messages on the conversation before `before`, newest first, each
   * redacted and trimmed from the middle, until EVIDENCE_HISTORY_MAX_CHARS is spent (the newest
   * are kept). Supplementary: no conversation or sender gives none, and a row without text is
   * skipped. A failed read throws to collect()'s catch like any other.
   */
  private async readSenderHistory(
    conversationId: string | null,
    senderId: unknown,
    before: Date,
    skip: ReadonlySet<string>,
  ): Promise<Array<{ at: string; text: string }>> {
    if (conversationId === null || typeof senderId !== 'string' || senderId === '') return [];
    const rows = await this.deps.auditLogRepo.findRecentInboundsFromSender(conversationId, senderId, before, SENDER_HISTORY_LIMIT);
    const out: Array<{ at: string; text: string }> = [];
    let total = 0;
    for (const row of rows) {
      const content = row.payload['content'];
      if (skip.has(row.id) || typeof content !== 'string') continue;
      const text = clipMiddle(redactSecrets(content), EVIDENCE_HISTORY_ITEM_MAX_CHARS);
      if (total + text.length > EVIDENCE_HISTORY_MAX_CHARS) break;
      total += text.length;
      out.push({ at: row.timestamp.toISOString(), text });
    }
    return out;
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
