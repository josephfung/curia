// send-ledger.ts — per-send marker documents for principal-mailbox sends (#2474, design D8).
//
// One create-only document per send attempt, so nothing read-modify-writes a shared set.
// ceo-inbox-sent-observe (and shadow-draft pairing) read the prefix to skip messages Curia sent,
// so they are not learned as the principal's own writing. A forged marker can only remove
// learning evidence (and, in PR 2, block an autonomous send), never allow one. Rewriting an
// existing marker could lift a thread's cooldown, so agents can't write the prefix at all:
// doc-write refuses it (#2474 final fixes B1), and only this class writes it, through the repo.

import { FALLBACK_MAILBOX_ID } from '../../principal-mailboxes/state-keys.js';
import type { WorkingDocRow, WorkingDocsRepo } from '../../db/working-docs-repo.js';
import type { Logger } from '../../logger.js';

export const PRINCIPAL_SEND_LEDGER_PREFIX = '/scratch/principal-mailbox-sends';
export const PRINCIPAL_SEND_DOC_TYPE = 'principal-mailbox-send';

export interface PrincipalSendEntry {
  draftId: string;
  threadId: string;
  /**
   * The mailbox the send went through (#2475). Absent on an entry written before the registry:
   * the per-mailbox thread cooldown reads such an entry as matching any mailbox, which can only
   * add cooldown (R40's reasoning).
   */
  mailbox?: string;
  /**
   * The conversation's RFC 5322 Message-IDs (the thread's Message-ID and References values,
   * lowercased, brackets stripped, capped), so the same conversation in another mailbox shares
   * them. Empty when the thread's headers were not read, or on an older entry.
   */
  conversationIds: string[];
  /**
   * Set when the stored `conversation_ids` could not be read (wrong type): the entry then matches
   * every conversation lookup, as an unreadable thread id matches every thread (fail closed).
   */
  conversationIdsUnreadable?: true;
  recipients: string[];
  mode: 'principal-directed' | 'autonomous';
  at: string;
  messageId?: string;
  /**
   * `limited` (#2475, Task 19): an autonomous send stopped only by the daily cap or the thread
   * cooldown. It is a record for the principal's report, never a send and never a cooldown: the
   * cap and both cooldowns skip it, so a limit stop cannot extend or deepen what stopped it.
   */
  outcome: 'sending' | 'sent' | 'held' | 'limited';
  /**
   * Why an autonomous send was held or refused (#2474 PR 2), as a code: the refusal code, or the
   * band rule ids (final fixes B2, security review L2). Never the free text: it can name
   * recipients and paraphrase the draft, and /scratch is agent-readable. The digest carries the
   * text to the principal. Only on `held` entries.
   */
  reasonCode?: string;
}

const MODES: readonly string[] = ['principal-directed', 'autonomous'];
const OUTCOMES: readonly string[] = ['sending', 'sent', 'held', 'limited'];

/** The limits a `limited` entry can name (the same codes the gateway refuses with). */
export type LimitStopReason = 'daily_cap' | 'thread_cooldown';

/** The path prefix of one draft's markers. The id is encoded: a path segment must not carry '/'. */
function draftPrefix(draftId: string): string {
  return `${PRINCIPAL_SEND_LEDGER_PREFIX}/${encodeURIComponent(draftId)}-`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * A ledger entry from its document, or null for a document of another type. A ledger document is
 * never dropped for a field it cannot read: a dropped autonomous send would lift the daily cap and
 * both cooldowns (fail-open, a forged or broken marker may only block, never allow). So each
 * unreadable field is read conservatively: `at` stays as given, so a non-string reads as the
 * empty text (recentness treats a non-date as recent), `mode` reads as autonomous, `outcome` as `sending` (a send, for the cap and the
 * cooldowns), `recipients` as none, a draft id as '' and a thread id as '' (which recentForThread
 * matches against any thread), `mailbox` as none (any mailbox) and `conversation_ids` as
 * unreadable (which recentForConversation matches against any conversation).
 */
export function parseLedgerDoc(doc: WorkingDocRow): PrincipalSendEntry | null {
  if (doc.type !== PRINCIPAL_SEND_DOC_TYPE) return null;
  const f = doc.frontmatter;
  // A held entry written before final fixes B2 carried a free-text `reason`; it is not read.
  const { draft_id: draftId, thread_id: threadId, recipients, mode, at, message_id: messageId, outcome, reason_code: reasonCode, mailbox, conversation_ids: conversationIds } = f;
  // A wrong-typed mailbox reads as none, which adds cooldown for every mailbox; wrong-typed
  // conversation ids are flagged, so the entry matches every conversation lookup. An absent field
  // (an older entry) is not wrong-typed: it reads as none and matches no conversation.
  return {
    draftId: typeof draftId === 'string' ? draftId : '',
    threadId: typeof threadId === 'string' ? threadId : '',
    recipients: isStringArray(recipients) ? recipients : [],
    // Not a string: the empty text is no date, so it counts as recent.
    at: typeof at === 'string' ? at : '',
    conversationIds: isStringArray(conversationIds) ? conversationIds : [],
    ...(conversationIds !== undefined && !isStringArray(conversationIds) ? { conversationIdsUnreadable: true as const } : {}),
    ...(typeof mailbox === 'string' ? { mailbox } : {}),
    mode: typeof mode === 'string' && MODES.includes(mode) ? mode as PrincipalSendEntry['mode'] : 'autonomous',
    outcome: typeof outcome === 'string' && OUTCOMES.includes(outcome) ? outcome as PrincipalSendEntry['outcome'] : 'sending',
    ...(typeof messageId === 'string' ? { messageId } : {}),
    ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
  };
}

export class PrincipalSendLedger {
  constructor(
    private readonly docs: Pick<WorkingDocsRepo, 'create' | 'read' | 'update' | 'listByPrefix'>,
    private readonly logger: Logger,
  ) {}

  /** Writes the marker before the send. Create-only, at a timestamped path. Throws on a repo failure. */
  async recordSending(e: Omit<PrincipalSendEntry, 'outcome' | 'messageId'> & { mailbox: string }): Promise<void> {
    const path = `${draftPrefix(e.draftId)}${Date.now()}.md`;
    await this.docs.create({
      path,
      type: PRINCIPAL_SEND_DOC_TYPE,
      frontmatter: {
        draft_id: e.draftId, thread_id: e.threadId, mailbox: e.mailbox, conversation_ids: e.conversationIds,
        recipients: e.recipients, mode: e.mode, at: e.at, outcome: 'sending',
      },
      body: '',
      // Unowned: the marker outlives the task that sent it, and /scratch's TTL retires it.
      taskId: null,
    });
  }

  /**
   * Records an autonomous send that was held or refused, with why as a code (#2474 PR 2). It starts the
   * thread's cooldown (checkAutonomousLimits), so a resampled judge gets one try a day.
   * Create-only like recordSending. Throws on a repo failure.
   */
  async recordHeld(e: Omit<PrincipalSendEntry, 'outcome' | 'messageId' | 'reasonCode'> & { reasonCode: string; mailbox: string }): Promise<void> {
    const path = `${draftPrefix(e.draftId)}${Date.now()}.md`;
    await this.docs.create({
      path,
      type: PRINCIPAL_SEND_DOC_TYPE,
      frontmatter: {
        draft_id: e.draftId, thread_id: e.threadId, mailbox: e.mailbox, conversation_ids: e.conversationIds,
        recipients: e.recipients, mode: e.mode, at: e.at,
        outcome: 'held', reason_code: e.reasonCode,
      },
      body: '',
      taskId: null,
    });
  }

  /**
   * Records an autonomous send stopped only by a limit (#2475, Task 19): `outcome: limited`, the
   * reason as the code. It is ignored by the cap and by both cooldowns, so recording it never
   * extends one; limitStopsSince reads it to tell the first stop of a day from a later one.
   * Create-only like recordSending. Throws on a repo failure.
   */
  async recordLimitStop(e: { draftId: string; mailbox: string; reason: LimitStopReason; at: string }): Promise<void> {
    const path = `${draftPrefix(e.draftId)}${Date.now()}.md`;
    await this.docs.create({
      path,
      type: PRINCIPAL_SEND_DOC_TYPE,
      frontmatter: {
        draft_id: e.draftId, thread_id: '', mailbox: e.mailbox, conversation_ids: [],
        recipients: [], mode: 'autonomous', at: e.at,
        outcome: 'limited', reason_code: e.reason,
      },
      body: '',
      taskId: null,
    });
  }

  /**
   * The `limited` entries for `reason` at or after `sinceEpochMs`. Unlike the cap's lookups an
   * unreadable `at` does not count here: this only decides which digest text is filed, and
   * "first" is the safe default for a broken marker. Throws on a repo failure.
   */
  async limitStopsSince(sinceEpochMs: number, reason: LimitStopReason, entries?: readonly PrincipalSendEntry[]): Promise<PrincipalSendEntry[]> {
    return (entries ?? await this.list()).filter((e) => e.outcome === 'limited' && e.reasonCode === reason && Date.parse(e.at) >= sinceEpochMs);
  }

  /**
   * Adds the sent message's id to the draft's latest `sending` marker. Throws on a repo failure;
   * a missing marker (its write failed earlier) is logged and skipped.
   */
  async recordSent(draftId: string, messageId: string): Promise<void> {
    const candidates = (await this.docs.listByPrefix(draftPrefix(draftId)))
      .map((doc) => ({ doc, entry: parseLedgerDoc(doc) }))
      .filter((c) => c.entry?.draftId === draftId && c.entry.outcome === 'sending')
      .sort((a, b) => a.doc.path.localeCompare(b.doc.path));
    const latest = candidates[candidates.length - 1];
    if (!latest) {
      this.logger.warn({ draftId }, 'principal-send-ledger: no sending marker for this draft — the sent message id is not recorded');
      return;
    }
    const result = await this.docs.update(latest.doc.path, {
      frontmatter: { ...latest.doc.frontmatter, message_id: messageId, outcome: 'sent' },
      expectedVersion: latest.doc.version,
    });
    if (!result.ok) {
      // Only this send writes its marker, so a conflict means something else touched it.
      this.logger.warn({ draftId, path: latest.doc.path }, 'principal-send-ledger: marker changed underneath — the sent message id is not recorded');
    }
  }

  /** Every marker, oldest path first. Malformed or foreign documents under the prefix are skipped. */
  async list(): Promise<PrincipalSendEntry[]> {
    const docs = await this.docs.listByPrefix(`${PRINCIPAL_SEND_LEDGER_PREFIX}/`);
    return docs.map(parseLedgerDoc).filter((e): e is PrincipalSendEntry => e !== null);
  }

  /**
   * Autonomous entries on `threadId` whose `at` is at or after `sinceEpochMs`, for the thread
   * cooldown (#2474 PR 2). `sinceEpochMs` is a cutoff time in epoch milliseconds, not a duration:
   * the gateway passes `now - AUTONOMOUS_THREAD_COOLDOWN_MS`. Only `mailbox`'s entries count, plus
   * legacy ones with none. An entry whose thread id is '' (unreadable, or never known) matches any
   * `threadId`, and an empty `threadId` asks for those entries only. Principal-directed sends never start a cooldown. Fails closed:
   * an entry with an unreadable `at` counts as recent, since a broken or forged marker may only
   * block autonomous sends on its thread, never allow one. Throws on a repo failure.
   */
  async recentForThread(threadId: string, sinceEpochMs: number, mailbox: string, entries?: readonly PrincipalSendEntry[]): Promise<PrincipalSendEntry[]> {
    // An entry with no mailbox (written before the registry) or the deferred-fallback id (R61) matches any: only more cooldown.
    return (entries ?? await this.list()).filter((e) => e.mode === 'autonomous' && e.outcome !== 'limited' && (e.threadId === threadId || e.threadId === '')
      && (e.mailbox === undefined || e.mailbox === FALLBACK_MAILBOX_ID || e.mailbox === mailbox) && atOrAfter(e, sinceEpochMs));
  }

  /**
   * Autonomous entries in any mailbox that share a Message-ID with `conversationIds` and sit at or
   * after `sinceEpochMs` (#2475): the same conversation copied into two inboxes has two thread ids
   * but the same Message-IDs. Fail closed on an unreadable `at`, as recentForThread. Throws on a
   * repo failure. No ids, no match.
   */
  async recentForConversation(conversationIds: readonly string[], sinceEpochMs: number, entries?: readonly PrincipalSendEntry[]): Promise<PrincipalSendEntry[]> {
    if (conversationIds.length === 0) return [];
    const wanted = new Set(conversationIds);
    return (entries ?? await this.list()).filter((e) => e.mode === 'autonomous' && e.outcome !== 'limited'
      && (e.conversationIdsUnreadable === true || e.conversationIds.some((id) => wanted.has(id))) && atOrAfter(e, sinceEpochMs));
  }

  /**
   * Autonomous sends (`sending` or `sent`, on any thread) whose `at` is at or after `sinceEpochMs`,
   * for the global daily cap (#2474 final fixes A4). A held marker is not a send. An unreadable
   * `at` counts, as in recentForThread (fail closed). Throws on a repo failure.
   */
  async recentAutonomousSends(sinceEpochMs: number, entries?: readonly PrincipalSendEntry[]): Promise<PrincipalSendEntry[]> {
    return (entries ?? await this.list()).filter((e) => e.mode === 'autonomous' && e.outcome !== 'held' && e.outcome !== 'limited' && atOrAfter(e, sinceEpochMs));
  }

  /**
   * Whether a send of this draft was recorded as `sent` (#2474 final fixes A12): a second send
   * call on a draft that already went out finds it gone, which is no news for the principal.
   * Throws on a repo failure.
   */
  async sentForDraft(draftId: string): Promise<boolean> {
    return (await this.docs.listByPrefix(draftPrefix(draftId)))
      .map(parseLedgerDoc)
      .some((e) => e?.draftId === draftId && e.outcome === 'sent');
  }
}

/** The entry is at or after the cutoff; an unreadable `at` counts as recent (fail closed). */
function atOrAfter(e: PrincipalSendEntry, sinceEpochMs: number): boolean {
  const at = Date.parse(e.at);
  return !Number.isFinite(at) || at >= sinceEpochMs;
}
