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
// Run on prod:  DATABASE_URL is already present in the app container's environment, so
//               nothing needs forwarding. The container runs .ts through tsx, not node's
//               type stripping (see the Dockerfile's note on dynamic .ts handler imports):
//
//                 ssh <host> 'docker exec curia-curia-1 \
//                   ./node_modules/.bin/tsx scripts/kg-node-linkage-report.ts'
//
//               Verified against production 2026-09-02.
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
  /** Contacts linked to an ARCHIVED node: linked-looking but unable to hold anything. */
  archivedLink: number;
  /** Anchored nodes no contact references. Post-ADR-040 these never decay; watch it grow. */
  anchoredOrphans: number;
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
// order rather than guessing at it, since arm A asks the same question that resolver
// does: is there already an organization node for this contact? It tries, in order:
//   1. findEntities(domain)   → label or alias matches the email domain
//   2. findEntities(name)     → label or alias matches the display name
//   3. createEntity(...)      → mints a node carrying properties.domain
// Matching only properties->>'domain' would miss every org node created by any other
// path — notably EntityMemory.resolveOrCreate, used by memory-store and extract-facts,
// which creates nodes with empty properties.
//
// Every miss here is expensive in one direction only: it moves a contact from arm A
// to arm B, and arm B mints. So a false negative makes migration 085 create a second
// node for an organization that already has one — the label-keyed fragmentation
// ADR-040 is trying to avoid. That asymmetry is why the predicate is deliberately
// generous rather than exactly reproducing the historical collision path.
const REPORT_SQL = `
  SELECT
    c.kind,
    count(*)                                     AS total,
    count(*) FILTER (WHERE c.kg_node_id IS NULL) AS nodeless,
    count(*) FILTER (
      WHERE c.kg_node_id IS NULL
        AND c.kind = 'organization'
        AND EXISTS (
          SELECT 1
          FROM kg_nodes n
          WHERE n.type = 'organization'
            AND n.archived_at IS NULL
            AND (
              -- Name-based resolution needs no email. An org contact can be created
              -- with kind='organization' and no address at all (POST /api/kg/contacts
              -- takes kind directly), and migration 056 set the kind from the linked
              -- node's type. Gating the whole predicate on primary_email would push
              -- those into arm B and have 085 mint a second node for an organization
              -- that already has one.
              lower(n.label) = lower(c.display_name)
              OR n.aliases @> ARRAY[lower(c.display_name)]
              -- Domain-based resolution obviously does need one.
              OR (
                c.primary_email IS NOT NULL
                AND (
                  lower(n.label) = lower(split_part(c.primary_email, '@', 2))
                  OR n.aliases @> ARRAY[lower(split_part(c.primary_email, '@', 2))]
                  OR lower(n.properties->>'domain') = lower(split_part(c.primary_email, '@', 2))
                )
              )
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
    ) AS shadowed,
    -- Contacts whose kg_node_id points at an ARCHIVED node. These look linked and are
    -- broken: getNode() filters archived_at, so they resolve to nothing and hold no facts,
    -- relationships or enrichment — the #1694 failure with a non-NULL pointer. They are
    -- invisible to the nodeless count above, which is why this column exists. Migration
    -- 085 step 2a repairs them; this is how you check the count before and after.
    count(*) FILTER (
      WHERE c.kg_node_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM kg_nodes n
           WHERE n.id = c.kg_node_id
             AND n.archived_at IS NOT NULL
        )
    ) AS archived_link,
    -- Anchored nodes with no contact pointing at them. Post-ADR-040 these never decay and
    -- are never archived, so they accumulate: an abandoned adoption, or a contact merge
    -- whose KG half failed (#1711). Two same-label person nodes make resolveOrCreate
    -- return 'ambiguous', so a growing number here means facts silently stop landing.
    -- Not per-kind (it counts nodes, not contacts) — read it from any row.
    (
      SELECT count(*) FROM kg_nodes n
       WHERE n.identity_source = 'contact'
         AND n.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM contacts oc WHERE oc.kg_node_id = n.id)
    ) AS anchored_orphans
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

  const byKind: KindBreakdown[] = rows.map(row => {
    // Same reasoning as requireCount: a missing `kind` would render as the literal
    // string "undefined" in the report, which reads like a real contact kind.
    const kind = row['kind'];
    if (typeof kind !== 'string' || kind === '') {
      throw new Error(
        `kg-node-linkage-report: grouping column "kind" was ${JSON.stringify(kind)}, not a non-empty string`,
      );
    }
    return {
      kind,
      total: requireCount(row, 'total'),
      nodeless: requireCount(row, 'nodeless'),
    };
  });

  const totalContacts = byKind.reduce((sum, k) => sum + k.total, 0);
  const totalNodeless = byKind.reduce((sum, k) => sum + k.nodeless, 0);
  const orgArmEligible = rows.reduce((sum, row) => sum + requireCount(row, 'org_arm'), 0);
  const sameNameShadowed = rows.reduce((sum, row) => sum + requireCount(row, 'shadowed'), 0);
  const archivedLink = rows.reduce((sum, row) => sum + requireCount(row, 'archived_link'), 0);
  // Scalar subquery: identical on every group row, so read it once rather than summing.
  // An empty contacts table yields no rows at all, in which case there is nothing linked
  // and therefore nothing orphaned either.
  const anchoredOrphans = rows[0] ? requireCount(rows[0], 'anchored_orphans') : 0;

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
    archivedLink,
    anchoredOrphans,
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
    '',
    '  other broken linkage (not part of the nodeless count above):',
    `    linked to an ARCHIVED node   ${report.archivedLink}   (085 step 2a repairs these)`,
    `    anchored nodes with no contact ${report.anchoredOrphans}   (never decay — watch this grow)`,
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
      // pool.end() can reject (e.g. a client erroring during shutdown). Left
      // unguarded it would reject main() itself — an unhandled rejection at the
      // top-level await, after the report has already been printed. Surface it and
      // fail the exit code instead of losing a successful run to a teardown error.
      try {
        await pool.end();
      } catch (endErr) {
        logger.error({ err: endErr }, 'kg-node-linkage-report: failed to close the pool');
        process.exitCode = 1;
      }
    }
    // Deliberately no process.exit(): stdout is asynchronous when piped (which the
    // documented `docker exec ... | tee` invocation is), and exiting here would
    // discard buffered output mid-report. Setting exitCode and returning lets the
    // event loop drain the write first.
  };
  await main();
}
