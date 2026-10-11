// principal-backlog.ts — counts what is waiting on the principal, for the backlog line on
// principal turns (prompt trim PR 7, src/agents/prompts/backlog-line.ts).
//
// One round trip per principal inbound, three counts. Each WHERE matches the read the
// coordinator would then call to see the items, so the line never promises something the
// tool does not show:
//   - decay warnings: KnowledgeGraph.listDecayWarnings (decay-warnings-list)
//   - pending approvals: ActionLogRepo.findAllPending (list-pending-actions)
//   - tasks the principal owns: task-list with owner `ceo` and any open status
// tests/integration/dispatch/principal-backlog.test.ts checks the counts against those reads.

import { OPEN_TASK_STATUSES, type PrincipalBacklogCounts } from '../agents/prompts/backlog-line.js';
import type { DbPool } from '../db/connection.js';

/** Where the dispatcher gets the counts. The scenario harness supplies a seeded one. */
export interface PrincipalBacklogSource {
  counts(): Promise<PrincipalBacklogCounts>;
}

export function createPrincipalBacklogSource(pool: DbPool): PrincipalBacklogSource {
  return {
    async counts(): Promise<PrincipalBacklogCounts> {
      const result = await pool.query<{ decay_warnings: number; pending_approvals: number; principal_tasks: number }>(
        `SELECT
           (SELECT count(*)::int FROM kg_nodes
             WHERE warned_at IS NOT NULL
               AND archived_at IS NULL
               AND identity_source = 'label') AS decay_warnings,
           (SELECT count(*)::int FROM autonomy_action_log
             WHERE outcome = 'pending_approval'
               AND expires_at > now()) AS pending_approvals,
           (SELECT count(*)::int FROM tasks
             WHERE owner = 'ceo'
               AND status = ANY($1::text[])) AS principal_tasks`,
        [OPEN_TASK_STATUSES],
      );
      const row = result.rows[0]!;
      return {
        decayWarnings: row.decay_warnings,
        pendingApprovals: row.pending_approvals,
        principalTasks: row.principal_tasks,
      };
    },
  };
}
