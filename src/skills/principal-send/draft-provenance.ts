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
// editedByCuria is the other direction (#2474 final review S1): a principal-directed send gives a
// draft Curia edited more review than one only the principal wrote, so there an edit adds review.

import type { AuditLogRepo, AuditLogRow } from '../../audit/audit-log-repo.js';
import type { Logger } from '../../logger.js';

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
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The draft id a successful result of one of `tools` names, or null for anything else. */
function resultDraftId(row: AuditLogRow, tools: readonly string[], skipExisting: boolean): string | null {
  const toolName = row.payload['toolName'] ?? row.payload['skillName'] ?? row.targetId;
  if (typeof toolName !== 'string' || !tools.includes(toolName)) return null;
  const result = record(row.payload['result']);
  if (result?.['success'] !== true) return null;
  const data = record(result['data']);
  if (!data || (skipExisting && data['already_exists'] === true)) return null;
  const id = data['draft_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export class DraftProvenance {
  constructor(
    private readonly repo: Pick<AuditLogRepo, 'findToolResults' | 'findToolResultsForTasks'>,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Draft IDs a successful draft-reply/compose created (already_exists !== true) in the lookback. Throws on repo failure. */
  async createdByCuria(draftIds: readonly string[], lookbackDays: number = PROVENANCE_LOOKBACK_DAYS): Promise<Set<string>> {
    return this.findDraftIds(draftIds, CURIA_DRAFT_TOOLS, true, lookbackDays);
  }

  /**
   * What task `taskEventId` (its agent.task audit event) wrote to `draftId`: `created` from a
   * draft-reply/compose result that made it, `lastWriteAt` from that or a same-task draft-edit
   * (Curia's own bounce edit). Edits never set `created`. Throws on repo failure.
   */
  async curiaWritesInTask(draftId: string, taskEventId: string): Promise<CuriaDraftWrites> {
    const rows = await this.repo.findToolResultsForTasks([taskEventId], PAGE_SIZE);
    if (rows.length >= PAGE_SIZE) {
      // Rows come newest first, so a full page may have cut off the create: `created` then reads
      // false and the send is refused (fail closed). A task this busy is not a routine reply.
      this.logger.warn({ draftId, taskEventId }, 'draft-provenance: task tool results hit the read cap — an older create may be unseen');
    }
    let created = false;
    let lastWriteAt: Date | null = null;
    for (const row of rows) {
      const isCreate = resultDraftId(row, CURIA_DRAFT_TOOLS, true) === draftId;
      if (!isCreate && resultDraftId(row, CURIA_EDIT_TOOLS, false) !== draftId) continue;
      if (isCreate) created = true;
      if (lastWriteAt === null || row.timestamp.getTime() > lastWriteAt.getTime()) lastWriteAt = row.timestamp;
    }
    return { created, lastWriteAt };
  }

  /**
   * Draft IDs a successful ceo-inbox-draft-edit returned in the lookback (#2474 final review S1).
   * For the review decision on a principal-directed send only; never an autonomous allowance.
   * Throws on repo failure.
   */
  async editedByCuria(draftIds: readonly string[], lookbackDays: number = PROVENANCE_LOOKBACK_DAYS): Promise<Set<string>> {
    return this.findDraftIds(draftIds, CURIA_EDIT_TOOLS, false, lookbackDays);
  }

  private async findDraftIds(
    draftIds: readonly string[],
    tools: readonly string[],
    skipExisting: boolean,
    lookbackDays: number,
  ): Promise<Set<string>> {
    const wanted = new Set(draftIds);
    const found = new Set<string>();
    if (wanted.size === 0) return found;
    const until = this.now();
    let since = new Date(until.getTime() - lookbackDays * DAY_MS);
    // Rows come oldest first, at most PAGE_SIZE a call: page forward from the last row's time.
    // A row at the boundary timestamp is read twice; the set makes that harmless.
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.repo.findToolResults({ since, until, toolNames: [...tools], limit: PAGE_SIZE });
      for (const row of rows) {
        const id = resultDraftId(row, tools, skipExisting);
        if (id !== null && wanted.has(id)) found.add(id);
      }
      if (found.size === wanted.size || rows.length < PAGE_SIZE) return found;
      const last = rows[rows.length - 1]!.timestamp;
      // A full page all at one instant cannot be paged past by time; stop with what was read.
      if (last.getTime() <= since.getTime()) break;
      since = last;
    }
    // Fail toward review: a draft missed here would read as the principal's and skip the review,
    // so a read that could not finish throws, and the gateway then treats the draft as Curia's.
    this.logger.warn({ lookbackDays, tools, wanted: wanted.size, found: found.size }, 'draft-provenance: audit read truncated — not deciding who wrote the draft');
    throw new Error('draft-provenance: audit read truncated');
  }
}
