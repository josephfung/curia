// send-ledger.ts — per-send marker documents for principal-mailbox sends (#2474, design D8).
//
// One create-only document per send attempt, so nothing read-modify-writes a shared set.
// ceo-inbox-sent-observe (and shadow-draft pairing) read the prefix to skip messages Curia sent,
// so they are not learned as the principal's own writing. A forged marker can only remove
// learning evidence (and, in PR 2, block an autonomous send), never allow one. Rewriting an
// existing marker could lift a thread's cooldown, so agents can't write the prefix at all:
// doc-write refuses it (#2474 final fixes B1), and only this class writes it, through the repo.

import type { WorkingDocRow, WorkingDocsRepo } from '../../db/working-docs-repo.js';
import type { Logger } from '../../logger.js';

export const PRINCIPAL_SEND_LEDGER_PREFIX = '/scratch/principal-mailbox-sends';
export const PRINCIPAL_SEND_DOC_TYPE = 'principal-mailbox-send';

export interface PrincipalSendEntry {
  draftId: string;
  threadId: string;
  recipients: string[];
  mode: 'principal-directed' | 'autonomous';
  at: string;
  messageId?: string;
  outcome: 'sending' | 'sent' | 'held';
  /**
   * Why an autonomous send was held or refused (#2474 PR 2), as a code: the refusal code, or the
   * band rule ids (final fixes B2, security review L2). Never the free text: it can name
   * recipients and paraphrase the draft, and /scratch is agent-readable. The digest carries the
   * text to the principal. Only on `held` entries.
   */
  reasonCode?: string;
}

const MODES: readonly string[] = ['principal-directed', 'autonomous'];
const OUTCOMES: readonly string[] = ['sending', 'sent', 'held'];

/** The path prefix of one draft's markers. The id is encoded: a path segment must not carry '/'. */
function draftPrefix(draftId: string): string {
  return `${PRINCIPAL_SEND_LEDGER_PREFIX}/${encodeURIComponent(draftId)}-`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** A ledger entry from its document, or null for any other or malformed document. */
export function parseLedgerDoc(doc: WorkingDocRow): PrincipalSendEntry | null {
  if (doc.type !== PRINCIPAL_SEND_DOC_TYPE) return null;
  const f = doc.frontmatter;
  // A held entry written before final fixes B2 carried a free-text `reason`; it is not read.
  const { draft_id: draftId, thread_id: threadId, recipients, mode, at, message_id: messageId, outcome, reason_code: reasonCode } = f;
  if (typeof draftId !== 'string' || typeof threadId !== 'string' || typeof at !== 'string') return null;
  if (!isStringArray(recipients)) return null;
  if (typeof mode !== 'string' || !MODES.includes(mode)) return null;
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;
  if (messageId !== undefined && typeof messageId !== 'string') return null;
  if (reasonCode !== undefined && typeof reasonCode !== 'string') return null;
  return {
    draftId, threadId, recipients, at,
    mode: mode as PrincipalSendEntry['mode'],
    outcome: outcome as PrincipalSendEntry['outcome'],
    ...(messageId !== undefined ? { messageId } : {}),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  };
}

export class PrincipalSendLedger {
  constructor(
    private readonly docs: Pick<WorkingDocsRepo, 'create' | 'read' | 'update' | 'listByPrefix'>,
    private readonly logger: Logger,
  ) {}

  /** Writes the marker before the send. Create-only, at a timestamped path. Throws on a repo failure. */
  async recordSending(e: Omit<PrincipalSendEntry, 'outcome' | 'messageId'>): Promise<void> {
    const path = `${draftPrefix(e.draftId)}${Date.now()}.md`;
    await this.docs.create({
      path,
      type: PRINCIPAL_SEND_DOC_TYPE,
      frontmatter: {
        draft_id: e.draftId, thread_id: e.threadId, recipients: e.recipients, mode: e.mode, at: e.at, outcome: 'sending',
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
  async recordHeld(e: Omit<PrincipalSendEntry, 'outcome' | 'messageId' | 'reasonCode'> & { reasonCode: string }): Promise<void> {
    const path = `${draftPrefix(e.draftId)}${Date.now()}.md`;
    await this.docs.create({
      path,
      type: PRINCIPAL_SEND_DOC_TYPE,
      frontmatter: {
        draft_id: e.draftId, thread_id: e.threadId, recipients: e.recipients, mode: e.mode, at: e.at,
        outcome: 'held', reason_code: e.reasonCode,
      },
      body: '',
      taskId: null,
    });
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
   * the gateway passes `now - AUTONOMOUS_THREAD_COOLDOWN_MS`. Principal-directed sends never start a cooldown. Fails closed:
   * an entry with an unreadable `at` counts as recent, since a broken or forged marker may only
   * block autonomous sends on its thread, never allow one. Throws on a repo failure.
   */
  async recentForThread(threadId: string, sinceEpochMs: number): Promise<PrincipalSendEntry[]> {
    return (await this.list()).filter((e) => e.mode === 'autonomous' && e.threadId === threadId && atOrAfter(e, sinceEpochMs));
  }

  /**
   * Autonomous sends (`sending` or `sent`, on any thread) whose `at` is at or after `sinceEpochMs`,
   * for the global daily cap (#2474 final fixes A4). A held marker is not a send. An unreadable
   * `at` counts, as in recentForThread (fail closed). Throws on a repo failure.
   */
  async recentAutonomousSends(sinceEpochMs: number): Promise<PrincipalSendEntry[]> {
    return (await this.list()).filter((e) => e.mode === 'autonomous' && e.outcome !== 'held' && atOrAfter(e, sinceEpochMs));
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
