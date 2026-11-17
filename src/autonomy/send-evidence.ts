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
import { isLiveTurnGrantActive } from './live-turn-grants.js';
import type { ContactTier, SystemRole } from '../contacts/types.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { OutreachLinkKind } from '../dispatch/outreach-matcher.js';
import { senderOwnTextAnyChannel } from '../dispatch/turn-guidance-triggers.js';
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
 * the middle to EVIDENCE_HISTORY_ITEM_MAX_CHARS, so all SENDER_HISTORY_LIMIT always fit in
 * EVIDENCE_HISTORY_MAX_CHARS and long messages cannot push an older one out. Behind the origin
 * and ahead of the tool results in the budget.
 */
export const SENDER_HISTORY_LIMIT = 5;
export const EVIDENCE_HISTORY_ITEM_MAX_CHARS = 600;
export const EVIDENCE_HISTORY_MAX_CHARS = SENDER_HISTORY_LIMIT * EVIDENCE_HISTORY_ITEM_MAX_CHARS;
/** Follow-ups a turn lane drained into the root turn, newest kept (#2499). */
export const ORIGIN_FOLLOW_UPS_LIMIT = 5;
/** Between the root inbound and each follow-up in the origin text. */
export const FOLLOW_UP_SEPARATOR = '\n\n[Follow-up the sender sent while the assistant was working on the message above]\n\n';
/**
 * Delegation hops followed to the root. The coordinator is the only caller of `delegate`, so
 * a real chain is one hop; the bound stops a malformed or cyclic chain. Longer is a failure.
 */
export const DELEGATION_MAX_HOPS = 4;
/**
 * Content-block rewrites followed back to the drafting turn (#2615). The dispatcher allows two
 * rewrites after the first block (CONTENT_BLOCK_MAX_RETRIES); the bound stops a malformed chain.
 */
export const REWRITE_MAX_HOPS = 4;

/** A content-block rewrite turn: Curia's brief to itself, marked by the dispatcher (#1355). */
function isContentBlockRewrite(row: AuditLogRow): boolean {
  const metadata = row.payload['metadata'];
  return row.eventType === 'agent.task'
    && row.payload['syntheticTurn'] === true
    && isRecord(metadata) && metadata['contentBlockRewrite'] === true;
}
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

/**
 * Replace credential-shaped substrings (API keys, bearer tokens, long hex) with [REDACTED].
 * Also used for the content-block rewrite's account of its turn's tool calls (#2615).
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of createSecretPatterns()) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * A tool.result row's result as text, credentials redacted. Also used for the content-block
 * rewrite's account of what its turn already did (#2615).
 */
export function renderResult(payload: Record<string, unknown>): string {
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

/**
 * The message an autonomous principal-mailbox reply answers (#2474), as origin evidence:
 * credentials redacted, trimmed from the middle like a delegation origin.
 */
export function replyTargetEvidence(text: string): string {
  return clipMiddle(redactSecrets(text), EVIDENCE_ORIGIN_MAX_CHARS);
}

/**
 * An autonomous reply's thread (#2474), the most the judge reads of it. Each message is clipped
 * like a reply target, so roughly the four newest always fit.
 */
export const EVIDENCE_THREAD_MAX_CHARS = 16_000;

/**
 * An autonomous principal-mailbox reply's thread as `off-thread` evidence (#2474): newest first
 * (undated last), credentials redacted, each message trimmed from the middle, and older messages
 * left out past EVIDENCE_THREAD_MAX_CHARS. Leaving a message out fails closed: what only it said
 * reads as not on the thread, so the reply holds.
 */
export function threadEvidence(messages: ReadonlyArray<{ at?: string; text: string }>): {
  threadMessages: Array<{ at?: string; text: string }>;
  threadMessagesOlderLeftOut?: true;
} {
  const time = (at: string | undefined): number => {
    const ms = at === undefined ? Number.NaN : Date.parse(at);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  // Compared, not subtracted: two undated messages would give -Infinity - -Infinity = NaN.
  const newestFirst = [...messages].sort((a, b) => {
    const [ta, tb] = [time(a.at), time(b.at)];
    return ta === tb ? 0 : tb > ta ? 1 : -1;
  });
  const out: Array<{ at?: string; text: string }> = [];
  let used = 0;
  for (const m of newestFirst) {
    const text = clipMiddle(redactSecrets(m.text), EVIDENCE_ORIGIN_MAX_CHARS);
    if (used + text.length > EVIDENCE_THREAD_MAX_CHARS) {
      return { threadMessages: out, threadMessagesOlderLeftOut: true };
    }
    used += text.length;
    out.push({ ...(m.at !== undefined ? { at: m.at } : {}), text });
  }
  return { threadMessages: out };
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

/**
 * The principal's own words that directed a send, read from collected evidence, for the
 * outbound Stage 2 judge (scenario 34d). Pure: the caller collects, this only decides.
 *
 * Fail-closed: anything short of a readable message from a live, channel-authenticated
 * principal turn is refused with a reason the caller logs. The authority check mirrors band
 * review's 'principal' authority (stamped originator systemRole, plus the drafting turn's
 * liveTurn) and adds `originator.authenticated === true`.
 *
 * Which text counts: only `principalMessage`, which collect() reads from the raw
 * inbound.message row the turn answered (a delegated turn's root inbound). Never the drafting
 * turn's task content: for a delegated turn that is the assistant's rewritten brief, and for
 * any turn it is the dispatcher's assembled prompt, which carries outsiders' replies in its
 * outbound-context preamble (security review SEC-HIGH-1).
 */
export function principalDirectiveFrom(
  collected: CollectedEvidence,
): { ok: true; text: string } | { ok: false; reason: string } {
  if (collected.unavailable) return { ok: false, reason: 'evidence unavailable' };
  const { authority } = collected;
  if (authority.originator?.systemRole !== 'principal') return { ok: false, reason: 'drafting turn not principal-originated' };
  // SEC-HIGH-2: stampOriginator marks any inbound that resolves to a principal identity as
  // principal, authenticated or not. A forged email From or a spoofed SMS number (ADR-036)
  // would otherwise direct a release; only a channel-verified sender counts.
  if (authority.originator.authenticated !== true) return { ok: false, reason: 'principal sender not authenticated by the channel' };
  if (!authority.liveTurn) return { ok: false, reason: 'drafting turn is not a live turn' };
  if (collected.originContent !== undefined && collected.originKind !== 'inbound') {
    return { ok: false, reason: 'delegation origin is not an inbound message' };
  }
  const text = collected.principalMessage;
  if (text === undefined || text.trim() === '') {
    return { ok: false, reason: 'the principal\'s own inbound message is absent or empty' };
  }
  return { ok: true, text };
}

/** The delegation chain's root task, or why it could not be followed. */
type DelegationRoot =
  | { ok: true; root: AuditLogRow | null }
  | { ok: false; reason: string };

/** The sender's earlier messages, and whether older ones exist past the limit. */
interface SenderHistory {
  items: Array<{ at: string; text: string; senderVerified?: boolean }>;
  olderLeftOut: boolean;
}

/** One inbound message's raw text and the channel it came in on. */
interface InboundPart {
  channelId: string;
  text: string;
}

/**
 * An inbound turn's message and drained follow-ups, oldest first, and every inbound row read
 * (`used`), or why they could not be read.
 */
type InboundRead =
  | { ok: true; parts: InboundPart[]; used: Set<string> }
  | { ok: false; reason: string };

/** What started the chain, as the judge sees it, or why it could not be read. */
type OriginRead =
  | { ok: true; content: string; kind: 'inbound' | 'task'; at: string; history: SenderHistory; parts?: InboundPart[] }
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

      // A content-block rewrite has no tools (#2615), so its own turn looked nothing up: the
      // facts in its reply come from the turn that drafted the blocked one. The band ledger
      // links the two only after a band bounce; after any other block (the identity gate, the
      // leak judge) the rewrite would be judged with no evidence at all, and every true
      // statement about the principal would read as unsupported.
      const drafting = await this.withRewriteOrigins(taskEventIds, task);

      // A delegated turn: what started the chain, in its sender's words (#2499).
      // Across every drafting turn the ledger passed: a rewrite after a bounce is a new turn in
      // the coordinator's conversation, but the bounced draft's turn still carries the origin.
      const delegation = await this.readDelegationRootOf(drafting, task);
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
      const historyChars = origin?.history.items.reduce((n, h) => n + h.text.length, 0) ?? 0;
      // The origin is kept first, then the sender's earlier messages; the tool results share
      // what is left of the budget.
      const resultsBudget = EVIDENCE_TOTAL_MAX_CHARS - (originContent?.length ?? 0) - historyChars;

      const results = await this.deps.auditLogRepo.findToolResultsForTasks(drafting, RESULTS_LIMIT);
      if (results.length === RESULTS_LIMIT) {
        this.deps.logger.info({ taskEventIds: drafting, limit: RESULTS_LIMIT }, 'send-evidence: result limit reached — older lookups left out');
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
      const reportRows = await this.deps.auditLogRepo.findPrincipalReportsForTasks(drafting, REPORTS_LIMIT);
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
      const principalMessage = await this.readPrincipalMessage(authority, origin, task, drafting);

      return {
        unavailable: false,
        authority,
        ...(link !== null ? { linkedOutreachId: link.outreachId } : {}),
        ...(decisions ? { decisions } : {}),
        ...(reportsToPrincipal.length > 0 ? { reportsToPrincipal } : {}),
        ...(origin ? { originContent: origin.content, originKind: origin.kind, originAt: origin.at } : {}),
        ...(origin && origin.history.items.length > 0 ? { senderHistory: origin.history.items } : {}),
        ...(origin?.history.olderLeftOut ? { senderHistoryOlderLeftOut: true } : {}),
        ...(principalMessage !== undefined ? { principalMessage } : {}),
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
   * The ids with the drafting turns of any content-block rewrite among them put first, oldest
   * first, each once (#2615). A rewrite's audit chain is written by code: its task is parented on
   * the outbound.blocked event, which is parented on the relayed outbound.message, then the
   * agent.response, then the turn that drafted it (itself a rewrite on a second attempt). Each hop
   * must be that event type in the rewrite's own conversation. A chain that cannot be followed (a
   * missing row, another type or conversation) adds nothing: less evidence makes the review
   * stricter, never looser, so it is logged and the review goes on. A read that throws is a
   * failed audit read like any other: it reaches collect()'s catch and the evidence is unavailable.
   */
  private async withRewriteOrigins(taskEventIds: readonly string[], latest: AuditLogRow): Promise<readonly string[]> {
    const origins: string[] = [];
    for (const id of taskEventIds) {
      const row = id === latest.id ? latest : await this.deps.auditLogRepo.findById(id);
      if (row === null || !isContentBlockRewrite(row)) continue;
      for (const origin of await this.rewriteOriginsOf(row)) {
        if (!origins.includes(origin)) origins.push(origin);
      }
    }
    if (origins.length === 0) return taskEventIds;
    return [...new Set([...origins, ...taskEventIds])];
  }

  /** The drafting turns behind one rewrite, oldest first. */
  private async rewriteOriginsOf(rewrite: AuditLogRow): Promise<string[]> {
    const read = async (id: string | null, eventType: string): Promise<AuditLogRow | null> => {
      if (id === null) return null;
      const row = await this.deps.auditLogRepo.findById(id);
      return row !== null && row.eventType === eventType && row.conversationId === rewrite.conversationId ? row : null;
    };
    const found: string[] = [];
    let current = rewrite;
    for (let hop = 0; hop < REWRITE_MAX_HOPS && isContentBlockRewrite(current); hop++) {
      const blocked = await read(current.parentEventId, 'outbound.blocked');
      const message = blocked && await read(blocked.parentEventId, 'outbound.message');
      const response = message && await read(message.parentEventId, 'agent.response');
      const drafting = response && await read(response.parentEventId, 'agent.task');
      if (!drafting) {
        this.deps.logger.warn(
          { rewriteTaskEventId: rewrite.id, at: current.id },
          'send-evidence: a content-block rewrite\'s drafting turn cannot be followed — judging without its lookups',
        );
        break;
      }
      found.push(drafting.id);
      current = drafting;
    }
    if (isContentBlockRewrite(current) && found.length === REWRITE_MAX_HOPS) {
      // More rewrites than the dispatcher allows: the oldest drafting turn is not reached.
      this.deps.logger.warn(
        { rewriteTaskEventId: rewrite.id, maxHops: REWRITE_MAX_HOPS },
        'send-evidence: a content-block rewrite chain ran past its hop bound — older lookups left out',
      );
    }
    return found.reverse();
  }

  /** The first (oldest) turn's delegation root among the ids; any turn whose chain fails fails all. */
  private async readDelegationRootOf(taskEventIds: readonly string[], latest: AuditLogRow): Promise<DelegationRoot> {
    let found: DelegationRoot = { ok: true, root: null };
    for (const id of taskEventIds) {
      const row = id === latest.id ? latest : await this.deps.auditLogRepo.findById(id);
      if (row === null) {
        this.deps.logger.warn({ taskEventId: id }, 'send-evidence: an earlier drafting turn is not in audit_log — its delegation is not read');
        continue;
      }
      const d = await this.readDelegationRoot(row);
      if (!d.ok) return d;
      if (found.ok && found.root === null) found = d;
    }
    return found;
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
    // A parent the root names but audit_log no longer has may have been the inbound: the task
    // content alone would stand in for the sender's words, so this is unresolved, not a task root.
    if (root.parentEventId && parent === null) return { ok: false, reason: 'root task\'s parent row not found in audit_log' };
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
    const read = await this.readInboundParts(root, parent);
    if (!read.ok) return read;
    const history = await this.readSenderHistory(parent.conversationId ?? root.conversationId, parent.payload['senderId'], parent.timestamp, read.used);
    return {
      ok: true, kind: 'inbound', at: parent.timestamp.toISOString(), history, parts: read.parts,
      content: clipMiddle(redactSecrets(read.parts.map((p) => p.text).join(FOLLOW_UP_SEPARATOR)), EVIDENCE_ORIGIN_MAX_CHARS),
    };
  }

  /**
   * An inbound turn's own words: its parent `inbound.message` as received (before any dispatcher
   * preamble), then the follow-ups a turn lane drained into the turn, oldest first. `used` is
   * every inbound row read, so the sender's history can skip them. A row without text is a
   * failure, never a shorter read.
   */
  private async readInboundParts(
    turn: AuditLogRow,
    inbound: AuditLogRow,
  ): Promise<InboundRead> {
    const part = (r: AuditLogRow): InboundPart | null => {
      const text = r.payload['content'];
      const channelId = r.payload['channelId'];
      return typeof text === 'string' ? { channelId: typeof channelId === 'string' ? channelId : '', text } : null;
    };
    const first = part(inbound);
    if (first === null) return { ok: false, reason: 'root inbound has no content' };
    const parts = [first];
    const used = new Set<string>([inbound.id]);
    if (turn.conversationId !== null) {
      // Turn lanes inject only the host turn's own sender (turn-lanes.ts), so these are that
      // sender's words too. Newest first from the repo, so a cut keeps the latest push; read
      // back oldest first.
      const ids = await this.deps.auditLogRepo.findInjectedInboundIds(turn.conversationId, turn.id, ORIGIN_FOLLOW_UPS_LIMIT);
      if (ids.length === ORIGIN_FOLLOW_UPS_LIMIT) {
        this.deps.logger.info({ rootTaskEventId: turn.id, limit: ORIGIN_FOLLOW_UPS_LIMIT }, 'send-evidence: follow-up limit reached — older follow-ups left out');
      }
      for (const id of [...ids].reverse()) {
        const row = await this.deps.auditLogRepo.findById(id);
        const followUp = row?.eventType === 'inbound.message' ? part(row) : null;
        if (followUp === null) return { ok: false, reason: 'a follow-up drained into the root turn cannot be read' };
        parts.push(followUp);
        used.add(id);
      }
    }
    return { ok: true, parts, used };
  }

  /**
   * The principal's own message for `principalMessage` (SEC-HIGH-1): the raw inbound the turn
   * answered, never its assembled task content. Read only when the authority could make it the
   * principal's (principal originator, live turn), so other turns cost no extra reads. For a
   * delegated turn, the root inbound readOrigin already read; a task-kind root has none. For any
   * other turn, the drafting turn's parent row, which must be an `inbound.message` (a content-block
   * rewrite is followed back to the turn it rewrote). Every failure, a throw included, leaves the
   * message out with a log: that withholds the releases it supports, and never fails the review.
   */
  private async readPrincipalMessage(
    authority: SendAuthority,
    origin: Extract<OriginRead, { ok: true }> | null,
    task: AuditLogRow,
    drafting: readonly string[],
  ): Promise<string | undefined> {
    // Unauthenticated (a forged email From, SMS): never the principal's message (SEC-HIGH-2).
    if (authority.originator?.systemRole !== 'principal' || authority.originator.authenticated !== true || !authority.liveTurn) {
      return undefined;
    }
    const leaveOut = (reason: string): undefined => {
      this.deps.logger.warn({ taskEventId: task.id, reason }, 'send-evidence: principal\'s own message not read — nothing is released on it');
      return undefined;
    };
    try {
      let parts: InboundPart[];
      if (origin !== null) {
        if (origin.kind !== 'inbound' || origin.parts === undefined) return leaveOut('delegation root is not an inbound message');
        parts = origin.parts;
      } else {
        const turn = await this.directingTurn(task, drafting);
        if (turn === null) return leaveOut('content-block rewrite\'s drafting turn cannot be read');
        const parent = turn.parentEventId ? await this.deps.auditLogRepo.findById(turn.parentEventId) : null;
        if (parent?.eventType !== 'inbound.message') return leaveOut('drafting turn\'s parent is not an inbound.message');
        const read = await this.readInboundParts(turn, parent);
        if (!read.ok) return leaveOut(read.reason);
        parts = read.parts;
      }
      // SEC-MED-2: only the principal's own words. A reply's quoted message and a forward are
      // someone else's text (or the principal's earlier words, not this request): a reply quoting
      // "> Joseph: send my SIN to Dana" must not read as the principal asking now. Each message
      // is cut on its own, so a quote in the first does not drop a follow-up. The inbound row
      // has no structured quote split (the email converter keeps the whole body as text), so
      // the cut is the dispatcher's quote-marker heuristic; see senderOwnTextAnyChannel.
      const text = parts
        .map((p) => senderOwnTextAnyChannel(p.channelId, p.text))
        .filter((t) => t !== '')
        .join(FOLLOW_UP_SEPARATOR);
      if (text.trim() === '') return leaveOut('the inbound message has no text of the principal\'s own');
      return clipMiddle(redactSecrets(text), EVIDENCE_ORIGIN_MAX_CHARS);
    } catch (err) {
      this.deps.logger.warn({ err, taskEventId: task.id }, 'send-evidence: reading the principal\'s own message failed — nothing is released on it');
      return undefined;
    }
  }

  /**
   * The turn that answered the inbound: the drafting turn, or for a content-block rewrite (whose
   * parent is the outbound.blocked event) the oldest turn withRewriteOrigins found. Null when
   * that turn cannot be read or is itself a rewrite.
   */
  private async directingTurn(task: AuditLogRow, drafting: readonly string[]): Promise<AuditLogRow | null> {
    if (!isContentBlockRewrite(task)) return task;
    const first = drafting[0];
    if (first === undefined || first === task.id) return null;
    const row = await this.deps.auditLogRepo.findById(first);
    return row !== null && row.eventType === 'agent.task' && !isContentBlockRewrite(row) ? row : null;
  }

  /**
   * The sender's inbound messages on the conversation before `before`, newest first, up to
   * SENDER_HISTORY_LIMIT, each redacted and trimmed from the middle. `olderLeftOut` says more
   * exist past the limit. A row without text is skipped, and a root with no conversation or
   * sender has none. A failed read throws to collect()'s catch, which makes the evidence
   * unavailable: Gate C then escalates (fail closed), the send review treats it as a judge
   * failure. Each item carries the channel's sender verification when it reports one (email:
   * SPF/DKIM/DMARC), so a forged message in the thread does not read as the sender's.
   */
  private async readSenderHistory(
    conversationId: string | null,
    senderId: unknown,
    before: Date,
    skip: ReadonlySet<string>,
  ): Promise<SenderHistory> {
    if (conversationId === null || typeof senderId !== 'string' || senderId === '') return { items: [], olderLeftOut: false };
    // One past the limit, to know whether older messages were left out.
    // Rows already used and rows without text are filtered in the query, before its limit, so
    // they cannot take a slot from a usable earlier message.
    const rows = await this.deps.auditLogRepo.findRecentInboundsFromSender(conversationId, senderId, before, SENDER_HISTORY_LIMIT + 1, [...skip]);
    const items: SenderHistory['items'] = [];
    for (const row of rows.slice(0, SENDER_HISTORY_LIMIT)) {
      const content = row.payload['content'];
      if (typeof content !== 'string') continue;
      const metadata = row.payload['metadata'];
      const verified = isRecord(metadata) ? metadata['senderVerified'] : undefined;
      items.push({
        at: row.timestamp.toISOString(),
        text: clipMiddle(redactSecrets(content), EVIDENCE_HISTORY_ITEM_MAX_CHARS),
        ...(typeof verified === 'boolean' ? { senderVerified: verified } : {}),
      });
    }
    return { items, olderLeftOut: rows.length > SENDER_HISTORY_LIMIT };
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
