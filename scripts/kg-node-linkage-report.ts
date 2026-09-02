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
//   Arm A (org)    — a nodeless contact with kind='organization' for which an existing
//                    organization node is already findable. These get re-linked to that
//                    node, which is only legal once the relaxed idx_contacts_kg_node_unique
//                    lands. No new nodes.
//   Arm B (person) — everything else. Each gets a freshly minted anchored node, so
//                    this count is exactly how many rows migration 085 inserts.
//
// `sameNameShadowed` is context rather than an arm: nodeless contacts that share a
// display name with a contact that *does* hold a node. That is the Seth Berman
// signature from #1623 — the collision that produced the NULL in the first place.
//
// Run locally:  pnpm run report:kg-linkage
// Run on prod:  export the deploy .env's DATABASE_URL, then forward it into the
//               container, which runs .ts through tsx (not node's type stripping —
//               see the Dockerfile's note on dynamic .ts handler imports):
//
//                 ssh <host> 'docker exec -e DATABASE_URL="$DATABASE_URL" \
//                   curia-curia-1 ./node_modules/.bin/tsx scripts/kg-node-linkage-report.ts'
//
// Safety: one statement, and it is a SELECT. This script writes nothing.

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
  /** Arm A: nodeless org contacts re-linkable to an organization node that already exists. */
  orgArmEligible: number;
  /** Arm B: nodeless contacts needing a freshly minted node — the insert count for 085. */
  personArmMints: number;
  /** Nodeless contacts whose display name is shared with a contact that has a node. */
  sameNameShadowed: number;
}

// Everything is counted in ONE statement so every number comes from a single MVCC
// snapshot. Split across separate queries, contact ingestion running concurrently
// could produce a report whose arms do not sum to its own total — and this report's
// only job is to be an accurate number.
//
// The arm-A predicate mirrors ContactService.resolveOrCreateOrgNode's resolution
// order rather than guessing at it, because arm A is defined as "the node the
// original collision denied this contact". That resolver tries, in order:
//   1. findEntities(domain)   → label or alias matches the email domain
//   2. findEntities(name)     → label or alias matches the display name
//   3. createEntity(...)      → mints a node carrying properties.domain
// Matching only properties->>'domain' would miss every org node created by any other
// path — notably EntityMemory.resolveOrCreate, used by memory-store and extract-facts,
// which creates nodes with empty properties. Each such miss silently moves a contact
// from arm A to arm B and inflates the migration's insert count.
const REPORT_SQL = `
  SELECT
    c.kind,
    count(*)                                     AS total,
    count(*) FILTER (WHERE c.kg_node_id IS NULL) AS nodeless,
    count(*) FILTER (
      WHERE c.kg_node_id IS NULL
        AND c.kind = 'organization'
        AND c.primary_email IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM kg_nodes n
          WHERE n.type = 'organization'
            AND n.archived_at IS NULL
            AND (
              lower(n.label) = lower(split_part(c.primary_email, '@', 2))
              OR n.aliases @> ARRAY[lower(split_part(c.primary_email, '@', 2))]
              OR lower(n.label) = lower(c.display_name)
              OR n.aliases @> ARRAY[lower(c.display_name)]
              OR lower(n.properties->>'domain') = lower(split_part(c.primary_email, '@', 2))
            )
        )
    ) AS org_arm,
    count(*) FILTER (
      WHERE c.kg_node_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM contacts o
          WHERE o.id <> c.id
            AND lower(o.display_name) = lower(c.display_name)
            AND o.kg_node_id IS NOT NULL
        )
    ) AS shadowed
  FROM contacts c
  GROUP BY c.kind
  ORDER BY c.kind
`;

// Postgres count(*) comes back as a string (int8 exceeds JS safe-integer range, so
// node-postgres declines to narrow it). Throw rather than defaulting: an aggregate
// column that is absent or unparseable means the query and this code have drifted
// apart, and coercing that to 0 would report "no work to do" — indistinguishable
// from a genuinely clean database, and precisely the silent failure that would size
// migration 085 at zero and leave the whole nodeless population context-free.
function requireCount(row: Record<string, unknown>, column: string): number {
  const raw = row[column];
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `kg-node-linkage-report: aggregate column "${column}" was ${JSON.stringify(raw)}, not a number — `
      + 'the query and the reader have drifted apart; refusing to report a fabricated count',
    );
  }
  return n;
}

export async function runLinkageReport(pool: PoolLike): Promise<LinkageReport> {
  const result = await pool.query(REPORT_SQL);
  const rows = result.rows as Array<Record<string, unknown>>;

  const byKind: KindBreakdown[] = rows.map(row => ({
    kind: String(row['kind']),
    total: requireCount(row, 'total'),
    nodeless: requireCount(row, 'nodeless'),
  }));

  const totalContacts = byKind.reduce((sum, k) => sum + k.total, 0);
  const totalNodeless = byKind.reduce((sum, k) => sum + k.nodeless, 0);
  const orgArmEligible = rows.reduce((sum, row) => sum + requireCount(row, 'org_arm'), 0);
  const sameNameShadowed = rows.reduce((sum, row) => sum + requireCount(row, 'shadowed'), 0);

  // Arm B is the remainder by construction: every nodeless contact arm A cannot
  // re-link needs a node minted. Because all four counts come from one statement,
  // arm A can never exceed the total — if it somehow does, the query is wrong and
  // clamping would hide that behind a plausible-looking number.
  if (orgArmEligible > totalNodeless) {
    throw new Error(
      `kg-node-linkage-report: arm A (${orgArmEligible}) exceeds the nodeless total (${totalNodeless}) — `
      + 'the report is internally inconsistent and must not be used to size a migration',
    );
  }
  const personArmMints = totalNodeless - orgArmEligible;

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
  const main = async (): Promise<void> => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      logger.error('kg-node-linkage-report: DATABASE_URL is not set');
      process.exitCode = 1;
      return;
    }
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const report = await runLinkageReport(pool);
      // Written rather than logged: this is the artifact a human reads off the
      // terminal, and pino's JSON would bury it. The structured line follows so the
      // same run is greppable when it is captured in container logs.
      process.stdout.write(`${formatReport(report)}\n`);
      logger.info(report, 'kg-node-linkage-report: done');
    } catch (err) {
      logger.error({ err }, 'kg-node-linkage-report: fatal error');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
    // Deliberately no process.exit(): stdout is asynchronous when piped (which the
    // documented `docker exec ... | tee` invocation is), and exiting here would
    // discard buffered output mid-report. Setting exitCode and returning lets the
    // event loop drain the write first.
  };
  await main();
}
