// draft-provenance.ts — which principal-mailbox drafts Curia wrote (#2474, design D2/D4.1).
//
// Read from tool.result audit rows: append-only and written by the runtime, never by an agent.
// Only draft-reply and draft-compose create a draft. createdByCuria never counts draft-edit
// results or voice-learning snapshots (agents can write the snapshots, and draft-edit touches any
// draft): PR 2's autonomous allowance keys on it, and an edit must not widen that. A draft-reply
// that handed back an existing draft (`already_exists: true`) did not write it.
//
// curiaWritesInTask is the autonomous allowance itself (#2474 PR 2, design D4.1-2): scoped to one
// task, so a backlog draft, a stale reply or a draft from an earlier task never qualifies.
//
// Drafts are identified by (mailbox, draft id) (#2475): Nylas ids are per grant, so two mailboxes
// can hold the same id. Result sets are keyed `${mailbox}:${draftId}` (draftKey). Audit rows from
// before the upgrade carry no `mailbox` and match the default mailbox.
//
// A draft-edit that moved a draft between mailboxes records `moved_from` ({ mailbox, draft_id }).
// The new draft inherits the source's class, so a move is never a way to lighter review: Curia's
// stays Curia's, and a move whose source cannot be read is Curia's too. A moved draft always has a
// draft-edit result, so it also counts as edited. It never counts as created in a task.
//
// editedByCuria is the other direction (#2474 final review S1): a principal-directed send gives a
// draft Curia edited more review than one only the principal wrote, so there an edit adds review.

import type { AuditLogRepo, AuditLogRow } from '../../audit/audit-log-repo.js';
import type { Logger } from '../../logger.js';
import { DEFAULT_MAILBOX } from './send-level.js';

export const CURIA_DRAFT_TOOLS = ['ceo-inbox-draft-reply', 'ceo-inbox-draft-compose'] as const;
export const CURIA_EDIT_TOOLS = ['ceo-inbox-draft-edit'] as const;
export const PROVENANCE_LOOKBACK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** findToolResults' own cap (MAX_LIMIT); a full page means there may be more. */
const PAGE_SIZE = 500;
/** 10,000 draft results in the lookback is far past any real mailbox; stop rather than loop. */
const MAX_PAGES = 20;

/** What one task wrote to one draft (#2474 PR 2). */
export interface CuriaDraftWrites {
  /** A successful draft-reply/compose in the task created this draft (already_exists !== true). */
  created: boolean;
  /** The latest such create, or successful draft-edit of the draft, in the same task. */
  lastWriteAt: Date | null;
  /**
   * The message the creating draft-reply answered (its result's `reply_to_message_id`, #2474
   * final fixes A5), or null: no create, a compose, or a result without one. Only the create's
   * row counts; an edit cannot rebind a draft to another message.
   */
  replyToMessageId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A draft's identity: its mailbox id and the Nylas draft id within that mailbox. */
export interface DraftRef {
  mailbox: string;
  draftId: string;
}

/** The key the result sets use. */
export function draftKey(mailbox: string, draftId: string): string {
  return `${mailbox}:${draftId}`;
}

/** Resolves the default mailbox id, which audit rows from before #2475 (no `mailbox`) belong to. */
export type DefaultMailboxId = () => Promise<string>;

const MAX_MOVE_DEPTH = 10;

interface ParsedResult {
  /** The row's mailbox, or null for a row from before #2475. */
  mailbox: string | null;
  draftId: string;
  /** undefined: not a move. null: a move whose source could not be read. */
  movedFrom?: { mailbox: string | null; draftId: string } | null;
  data: Record<string, unknown>;
}

/** The draft a successful result of one of `tools` names, or null for anything else. */
function parseResult(row: AuditLogRow, tools: readonly string[], skipExisting: boolean): ParsedResult | null {
  const toolName = row.payload['toolName'] ?? row.payload['skillName'] ?? row.targetId;
  if (typeof toolName !== 'string' || !tools.includes(toolName)) return null;
  const result = record(row.payload['result']);
  if (result?.['success'] !== true) return null;
  const data = record(result['data']);
  if (!data || (skipExisting && data['already_exists'] === true)) return null;
  const id = data['draft_id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const mailbox = typeof data['mailbox'] === 'string' && data['mailbox'].length > 0 ? data['mailbox'] : null;
  const parsed: ParsedResult = { mailbox, draftId: id, data };
  if ('moved_from' in data) {
    const from = record(data['moved_from']);
    const fromId = from?.['draft_id'];
    const fromMailbox = from?.['mailbox'];
    parsed.movedFrom = typeof fromId === 'string' && fromId.length > 0
      ? { mailbox: typeof fromMailbox === 'string' && fromMailbox.length > 0 ? fromMailbox : null, draftId: fromId }
      : null;
  }
  return parsed;
}

export class DraftProvenance {
  constructor(
    private readonly repo: Pick<AuditLogRepo, 'findToolResults' | 'findToolResultsForTasks'>,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly defaultMailboxId: DefaultMailboxId = async () => DEFAULT_MAILBOX,
  ) {}

  /**
   * Keys of the drafts a successful draft-reply/compose created (already_exists !== true) in the
   * lookback, or that are a move of such a draft. Throws on repo failure.
   */
  async createdByCuria(drafts: readonly DraftRef[], lookbackDays: number = PROVENANCE_LOOKBACK_DAYS): Promise<Set<string>> {
    return this.createdWithMoves(drafts, lookbackDays, 0);
  }

  private async createdWithMoves(drafts: readonly DraftRef[], lookbackDays: number, depth: number): Promise<Set<string>> {
    const found = await this.findDraftKeys(drafts, CURIA_DRAFT_TOOLS, true, lookbackDays);
    const remaining = drafts.filter((d) => !found.has(draftKey(d.mailbox, d.draftId)));
    if (remaining.length === 0) return found;
    // A draft that is not a create may be a move of one. Read the moves, then ask about the sources.
    const wanted = new Set(remaining.map((d) => draftKey(d.mailbox, d.draftId)));
    const sources = new Map<string, DraftRef | null>();
    const defaultId = await this.defaultMailboxId();
    await this.scan(CURIA_EDIT_TOOLS, false, lookbackDays, (row) => {
      if (row.movedFrom === undefined) return;
      const key = draftKey(row.mailbox ?? defaultId, row.draftId);
      if (!wanted.has(key)) return;
      sources.set(key, row.movedFrom === null ? null : { mailbox: row.movedFrom.mailbox ?? defaultId, draftId: row.movedFrom.draftId });
    });
    if (sources.size === 0) return found;
    const known = [...sources.values()].filter((s): s is DraftRef => s !== null);
    let sourceCreated = new Set<string>();
    if (known.length > 0) {
      if (depth >= MAX_MOVE_DEPTH) {
        // A chain this long is not real: fail toward review.
        this.logger.warn({ depth }, 'draft-provenance: move chain too deep — treating the draft as Curia\'s');
        sourceCreated = new Set(known.map((s) => draftKey(s.mailbox, s.draftId)));
      } else {
        sourceCreated = await this.createdWithMoves(known, lookbackDays, depth + 1);
      }
    }
    for (const [key, source] of sources) {
      // An unreadable source is Curia's.
      if (source === null || sourceCreated.has(draftKey(source.mailbox, source.draftId))) found.add(key);
    }
    return found;
  }

  /**
   * What task `taskEventId` (its agent.task audit event) wrote to `draft`: `created` from a
   * draft-reply/compose result that made it, `lastWriteAt` from that or a same-task draft-edit
   * (Curia's own bounce edit). Edits never set `created`. Throws on repo failure.
   */
  async curiaWritesInTask(draft: DraftRef, taskEventId: string): Promise<CuriaDraftWrites> {
    const rows = await this.repo.findToolResultsForTasks([taskEventId], PAGE_SIZE);
    if (rows.length >= PAGE_SIZE) {
      // Rows come newest first, so a full page may have cut off the create: `created` then reads
      // false and the send is refused (fail closed). A task this busy is not a routine reply.
      this.logger.warn({ draftId: draft.draftId, taskEventId }, 'draft-provenance: task tool results hit the read cap — an older create may be unseen');
    }
    const defaultId = await this.defaultMailboxId();
    const is = (parsed: ParsedResult | null): parsed is ParsedResult =>
      parsed !== null && parsed.draftId === draft.draftId && (parsed.mailbox ?? defaultId) === draft.mailbox;
    let created = false;
    let lastWriteAt: Date | null = null;
    let replyToMessageId: string | null = null;
    for (const row of rows) {
      const create = parseResult(row, CURIA_DRAFT_TOOLS, true);
      const isCreate = is(create);
      if (!isCreate && !is(parseResult(row, CURIA_EDIT_TOOLS, false))) continue;
      if (isCreate) {
        created = true;
        const replied = create.data['reply_to_message_id'];
        if (typeof replied === 'string' && replied.length > 0) replyToMessageId = replied;
      }
      if (lastWriteAt === null || row.timestamp.getTime() > lastWriteAt.getTime()) lastWriteAt = row.timestamp;
    }
    return { created, lastWriteAt, replyToMessageId };
  }

  /**
   * Keys of the drafts a successful ceo-inbox-draft-edit returned in the lookback (#2474 final
   * review S1). A move is an edit of the new draft. For the review decision on a principal-directed
   * send only; never an autonomous allowance. Throws on repo failure.
   */
  async editedByCuria(drafts: readonly DraftRef[], lookbackDays: number = PROVENANCE_LOOKBACK_DAYS): Promise<Set<string>> {
    return this.findDraftKeys(drafts, CURIA_EDIT_TOOLS, false, lookbackDays);
  }

  private async findDraftKeys(
    drafts: readonly DraftRef[],
    tools: readonly string[],
    skipExisting: boolean,
    lookbackDays: number,
  ): Promise<Set<string>> {
    const wanted = new Set(drafts.map((d) => draftKey(d.mailbox, d.draftId)));
    const found = new Set<string>();
    if (wanted.size === 0) return found;
    const defaultId = await this.defaultMailboxId();
    await this.scan(tools, skipExisting, lookbackDays, (row) => {
      const key = draftKey(row.mailbox ?? defaultId, row.draftId);
      if (wanted.has(key)) found.add(key);
    }, () => found.size === wanted.size);
    return found;
  }

  /** Visits every successful result of `tools` in the lookback, oldest first. Throws if the read cannot finish. */
  private async scan(
    tools: readonly string[],
    skipExisting: boolean,
    lookbackDays: number,
    visit: (row: ParsedResult) => void,
    done: () => boolean = () => false,
  ): Promise<void> {
    const until = this.now();
    let since = new Date(until.getTime() - lookbackDays * DAY_MS);
    // Rows come oldest first, at most PAGE_SIZE a call: page forward from the last row's time.
    // A row at the boundary timestamp is read twice; callers' sets make that harmless.
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.repo.findToolResults({ since, until, toolNames: [...tools], limit: PAGE_SIZE });
      for (const row of rows) {
        const parsed = parseResult(row, tools, skipExisting);
        if (parsed) visit(parsed);
      }
      if (done() || rows.length < PAGE_SIZE) return;
      const last = rows[rows.length - 1]!.timestamp;
      // A full page all at one instant cannot be paged past by time; stop with what was read.
      if (last.getTime() <= since.getTime()) break;
      since = last;
    }
    // Fail toward review: a draft missed here would read as the principal's and skip the review,
    // so a read that could not finish throws, and the gateway then treats the draft as Curia's.
    this.logger.warn({ lookbackDays, tools }, 'draft-provenance: audit read truncated — not deciding who wrote the draft');
    throw new Error('draft-provenance: audit read truncated');
  }
}
