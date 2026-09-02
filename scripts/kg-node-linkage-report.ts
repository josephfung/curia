// scripts/kg-node-linkage-report.ts
//
// Read-only report on contacts that hold no KG node (#1694 / ADR-040).
//
// A contact with kg_node_id = NULL cannot hold facts, relationships, or entity
// context, and nothing about that is visible from the outside — it looks identical
// to a contact nobody has learned anything about yet. This report is the standing
// count, and it exists to size migration 085 before that migration is written:
// ADR-040's backfill has two arms, and the work in each is very different.
//
//   Arm A (org)    — a nodeless contact with kind='organization' whose primary_email
//                    domain matches an existing organization node's properties->>'domain'.
//                    These get re-linked to that node, which is only legal once the
//                    relaxed idx_contacts_kg_node_unique lands. No new nodes.
//   Arm B (person) — everything else. Each gets a freshly minted anchored node, so
//                    this count is exactly how many rows migration 085 inserts.
//
// `sameNameShadowed` is context rather than an arm: nodeless contacts that share a
// display name with a contact that *does* hold a node. That is the Seth Berman
// signature from #1623 — the collision that produced the NULL in the first place.
//
// Run locally:  pnpm run report:kg-linkage
// Run on prod:  docker exec curia-curia-1 node --experimental-strip-types \
//                 scripts/kg-node-linkage-report.ts
//               (forward DATABASE_URL from the deploy .env)
//
// Safety: every statement is a SELECT. This script writes nothing.

import pg from 'pg';
import pino from 'pino';

const logger = pino({ name: 'kg-node-linkage-report' });
const { Pool } = pg;

/** Minimal structural type so tests can pass a mock without the full pg.Pool shape. */
type PoolLike = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

export interface KindBreakdown {
  kind: string;
  total: number;
  nodeless: number;
}

export interface LinkageReport {
  totalContacts: number;
  totalNodeless: number;
  byKind: KindBreakdown[];
  /** Arm A: nodeless org contacts re-linkable to an existing org node by email domain. */
  orgArmEligible: number;
  /** Arm B: nodeless contacts needing a freshly minted node — the insert count for 085. */
  personArmMints: number;
  /** Nodeless contacts whose display name is shared with a contact that has a node. */
  sameNameShadowed: number;
}

// Postgres count(*) comes back as a string (int8 exceeds JS safe-integer range, so
// node-postgres declines to narrow it). Parse explicitly; a missing or unparseable
// value becomes 0 rather than NaN, which would silently poison every derived total.
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function runLinkageReport(pool: PoolLike): Promise<LinkageReport> {
  // 1. Totals and nodeless counts per contact kind.
  const kindResult = await pool.query(
    `SELECT kind,
            count(*)                                    AS total,
            count(*) FILTER (WHERE kg_node_id IS NULL)  AS nodeless
     FROM contacts
     GROUP BY kind
     ORDER BY kind`,
  );

  const byKind: KindBreakdown[] = (kindResult.rows as Array<Record<string, unknown>>).map(row => ({
    kind: String(row['kind']),
    total: toCount(row['total']),
    nodeless: toCount(row['nodeless']),
  }));

  const totalContacts = byKind.reduce((sum, k) => sum + k.total, 0);
  const totalNodeless = byKind.reduce((sum, k) => sum + k.nodeless, 0);

  // 2. Arm A — nodeless org contacts whose email domain matches an existing org node.
  //    Mirrors resolveOrCreateOrgNode's domain lookup: that is the node the original
  //    collision denied them, and the node 085 re-links them to.
  const orgResult = await pool.query(
    `SELECT count(*) AS eligible
     FROM contacts c
     WHERE c.kg_node_id IS NULL
       AND c.kind = 'organization'
       AND c.primary_email IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM kg_nodes n
         WHERE n.type = 'organization'
           AND n.archived_at IS NULL
           AND lower(n.properties->>'domain') = lower(split_part(c.primary_email, '@', 2))
       )`,
  );
  const orgArmEligible = toCount((orgResult.rows[0] as Record<string, unknown> | undefined)?.['eligible']);

  // 3. Nodeless contacts shadowed by a same-display-name contact that does hold a node.
  const shadowResult = await pool.query(
    `SELECT count(*) AS shadowed
     FROM contacts c
     WHERE c.kg_node_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM contacts o
         WHERE o.id <> c.id
           AND lower(o.display_name) = lower(c.display_name)
           AND o.kg_node_id IS NOT NULL
       )`,
  );
  const sameNameShadowed = toCount((shadowResult.rows[0] as Record<string, unknown> | undefined)?.['shadowed']);

  // Arm B is the remainder by construction: every nodeless contact that arm A cannot
  // re-link needs a node minted. Deriving it rather than querying it separately keeps
  // the two arms guaranteed to sum to the total.
  const personArmMints = Math.max(0, totalNodeless - orgArmEligible);

  return {
    totalContacts,
    totalNodeless,
    byKind,
    orgArmEligible,
    personArmMints,
    sameNameShadowed,
  };
}

/** Render the report as a short human-readable block for terminal / docker logs. */
export function formatReport(report: LinkageReport): string {
  const lines = [
    'KG node linkage report (#1694 / ADR-040)',
    '',
    `  contacts total          ${report.totalContacts}`,
    `  contacts with no node   ${report.totalNodeless}`,
    '',
    '  by kind:',
    ...report.byKind.map(k => `    ${k.kind.padEnd(14)} ${String(k.nodeless).padStart(5)} nodeless / ${k.total} total`),
    '',
    '  migration 085 sizing:',
    `    arm A (org re-link)   ${report.orgArmEligible}`,
    `    arm B (mint a node)   ${report.personArmMints}`,
    '',
    `  of which shadowed by a same-name contact that has a node: ${report.sameNameShadowed}`,
  ];
  return lines.join('\n');
}

// CLI entry point — only runs when executed directly (not when imported by tests)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    logger.error('kg-node-linkage-report: DATABASE_URL is not set');
    process.exit(1);
  }
  const main = async (): Promise<void> => {
    const pool = new Pool({ connectionString: databaseUrl });
    let exitCode = 0;
    try {
      const report = await runLinkageReport(pool);
      // Printed rather than logged: this is the artifact a human reads off the
      // terminal, and pino's JSON would bury it. The structured line follows so the
      // same run is greppable when it is captured in container logs.
      process.stdout.write(`${formatReport(report)}\n`);
      logger.info(report, 'kg-node-linkage-report: done');
    } catch (err) {
      logger.error({ err }, 'kg-node-linkage-report: fatal error');
      exitCode = 1;
    } finally {
      await pool.end();
    }
    process.exit(exitCode);
  };
  await main();
}
