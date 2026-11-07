// draft-provenance.ts — which principal-mailbox drafts Curia wrote (#2474, design D2/D4.1).
//
// Read from tool.result audit rows: append-only and written by the runtime, never by an agent.
// Only draft-reply and draft-compose create a draft. draft-edit results and voice-learning
// snapshots are never counted (agents can write the snapshots, and draft-edit touches any draft),
// and a draft-reply that handed back an existing draft (`already_exists: true`) did not write it.

import type { AuditLogRepo, AuditLogRow } from '../../audit/audit-log-repo.js';
import type { Logger } from '../../logger.js';

export const CURIA_DRAFT_TOOLS = ['ceo-inbox-draft-reply', 'ceo-inbox-draft-compose'] as const;
export const PROVENANCE_LOOKBACK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** findToolResults' own cap (MAX_LIMIT); a full page means there may be more. */
const PAGE_SIZE = 500;
/** 10,000 draft results in the lookback is far past any real mailbox; stop rather than loop. */
const MAX_PAGES = 20;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The draft id a successful create wrote, or null for anything else. */
function createdDraftId(row: AuditLogRow): string | null {
  const toolName = row.payload['toolName'] ?? row.payload['skillName'] ?? row.targetId;
  if (typeof toolName !== 'string' || !(CURIA_DRAFT_TOOLS as readonly string[]).includes(toolName)) return null;
  const result = record(row.payload['result']);
  if (result?.['success'] !== true) return null;
  const data = record(result['data']);
  if (!data || data['already_exists'] === true) return null;
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
    const wanted = new Set(draftIds);
    const found = new Set<string>();
    if (wanted.size === 0) return found;
    const until = this.now();
    let since = new Date(until.getTime() - lookbackDays * DAY_MS);
    // Rows come oldest first, at most PAGE_SIZE a call: page forward from the last row's time.
    // A row at the boundary timestamp is read twice; the set makes that harmless.
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.repo.findToolResults({ since, until, toolNames: [...CURIA_DRAFT_TOOLS], limit: PAGE_SIZE });
      for (const row of rows) {
        const id = createdDraftId(row);
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
    this.logger.warn({ lookbackDays, wanted: wanted.size, found: found.size }, 'draft-provenance: audit read truncated — not deciding who wrote the draft');
    throw new Error('draft-provenance: audit read truncated');
  }
}
