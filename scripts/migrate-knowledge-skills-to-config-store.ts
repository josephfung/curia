#!/usr/bin/env tsx
/**
 * migrate-knowledge-skills-to-config-store.ts
 *
 * One-time migration: re-writes data from the four legacy knowledge-* skill
 * anchor nodes into config-store namespaces.
 *
 * Mapping:
 *   "company-overview"    → namespace "company"             (key=field, value=value)
 *   "meeting-links"       → namespace "meeting_links"       (key=fact label, value=link URL)
 *   "travel-preferences"  → namespace "travel_preferences"  (key=field, value=value)
 *   "loyalty-programs"    → namespace "loyalty_programs"    (key=program_name, value=JSON)
 *
 * Usage:
 *   pnpm tsx scripts/migrate-knowledge-skills-to-config-store.ts
 *   pnpm tsx scripts/migrate-knowledge-skills-to-config-store.ts --dry-run
 *
 * The --dry-run flag queries the DB to show what would be created vs. updated,
 * without making any writes.
 *
 * Safe to run multiple times: config-store uses label-based dedup, so re-running
 * on an already-migrated instance only updates rows in-place.
 *
 * Transaction strategy: all writes for all namespaces are wrapped in a single
 * transaction. Either everything commits or nothing does. Because the script is
 * idempotent (updates existing rows rather than failing), re-running after a
 * partial failure leaves the DB in a clean state.
 *
 * After verifying the migration in production, the old anchor nodes (bare labels
 * like "company-overview") are orphaned — config-store queries by "config:{namespace}"
 * and will never touch them. They can be left in place or archived manually.
 */

import pg from 'pg';

const { Pool } = pg;

// -- Config ----------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

// -- Types -----------------------------------------------------------------

interface KgNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  decay_class: string;
  source: string;
  sensitivity: string;
}

// A config-store entry ready to write into the KG
interface ConfigEntry {
  namespace: string;
  key: string;
  value: string;
}

// -- Namespace definitions -------------------------------------------------

const MIGRATIONS: Array<{
  oldAnchorLabel: string;
  namespace: string;
  transform: (fact: KgNode) => ConfigEntry | null;
}> = [
  {
    oldAnchorLabel: 'company-overview',
    namespace: 'company',
    // Facts stored as: label=field_name, properties={ value, field }
    transform: (fact) => {
      const key = (fact.properties.field as string | undefined) ?? fact.label;
      const value = fact.properties.value as string | undefined;
      if (!key || !value) return null;
      return { namespace: 'company', key, value };
    },
  },
  {
    oldAnchorLabel: 'travel-preferences',
    namespace: 'travel_preferences',
    // Facts stored as: label=field_name, properties={ value, field }
    transform: (fact) => {
      const key = (fact.properties.field as string | undefined) ?? fact.label;
      const value = fact.properties.value as string | undefined;
      if (!key || !value) return null;
      return { namespace: 'travel_preferences', key, value };
    },
  },
  {
    oldAnchorLabel: 'meeting-links',
    namespace: 'meeting_links',
    // Facts stored as: label="{person_name} {platform} link", properties={ person_name, platform, link }
    // Preserve the original fact label as the key (matches the coordinator prompt's key format).
    transform: (fact) => {
      const link = fact.properties.link as string | undefined;
      if (!link) return null;
      return { namespace: 'meeting_links', key: fact.label, value: link };
    },
  },
  {
    oldAnchorLabel: 'loyalty-programs',
    namespace: 'loyalty_programs',
    // Facts stored as: label=program_name, properties={ program_name, member_number, tier?, notes? }
    // Serialize structured data as a JSON string (config-store values are strings).
    transform: (fact) => {
      const key = (fact.properties.program_name as string | undefined) ?? fact.label;
      const member_number = fact.properties.member_number as string | undefined;
      if (!key || !member_number) return null;

      const payload: Record<string, string> = { member_number };
      if (fact.properties.tier) payload.tier = fact.properties.tier as string;
      if (fact.properties.notes) payload.notes = fact.properties.notes as string;

      return { namespace: 'loyalty_programs', key, value: JSON.stringify(payload) };
    },
  },
];

// -- KG helpers ------------------------------------------------------------

type Queryable = { query: pg.Pool['query'] };

/** config-store anchor label format (mirrors handler.ts anchorLabel()) */
function anchorLabel(namespace: string): string {
  return `config:${namespace}`;
}

/** Find all non-archived nodes with the given label (case-insensitive exact match) */
async function findNodesByLabel(db: Queryable, label: string): Promise<KgNode[]> {
  const result = await db.query<KgNode>(
    `SELECT id, type, label, properties, decay_class, source, sensitivity
     FROM kg_nodes
     WHERE lower(label) = lower($1) AND archived_at IS NULL`,
    [label],
  );
  return result.rows;
}

/** Get all non-archived fact nodes connected to the given entity node */
async function getFacts(db: Queryable, entityNodeId: string): Promise<KgNode[]> {
  const result = await db.query<KgNode>(
    `SELECT n.id, n.type, n.label, n.properties, n.decay_class, n.source, n.sensitivity
     FROM kg_edges e
     JOIN kg_nodes n ON n.id = e.target_node_id
     WHERE e.source_node_id = $1
       AND e.archived_at IS NULL
       AND n.archived_at IS NULL
       AND n.type = 'fact'`,
    [entityNodeId],
  );
  return result.rows;
}

/**
 * Upsert a config-store anchor node (type=concept, label="config:{namespace}").
 * Returns the anchor node id. Mirrors config-store/handler.ts findOrCreateAnchor.
 */
async function upsertConfigAnchor(db: Queryable, namespace: string): Promise<string> {
  const label = anchorLabel(namespace);

  const existing = await findNodesByLabel(db, label);
  if (existing.length > 0) return existing[0]!.id;

  const result = await db.query<{ id: string }>(
    `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, sensitivity)
     VALUES ('concept', $1, $2, 1.0, 'permanent', 'migration:knowledge-to-config-store', 'internal')
     RETURNING id`,
    [label, JSON.stringify({ category: 'config', namespace })],
  );
  if (!result.rows[0]) {
    throw new Error(`INSERT for anchor "${label}" returned no rows — check DB permissions`);
  }
  return result.rows[0].id;
}

/**
 * Register the namespace in the config-store meta-index.
 * Mirrors config-store/handler.ts registerNamespace.
 */
async function registerNamespace(db: Queryable, namespace: string): Promise<void> {
  const INDEX_LABEL = 'config-store-index';

  // Find or create the index node
  const indexNodes = await findNodesByLabel(db, INDEX_LABEL);
  let indexNodeId: string;

  if (indexNodes.length === 0) {
    const result = await db.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, sensitivity)
       VALUES ('concept', $1, $2, 1.0, 'permanent', 'migration:knowledge-to-config-store', 'internal')
       RETURNING id`,
      [INDEX_LABEL, JSON.stringify({ category: 'config-meta' })],
    );
    if (!result.rows[0]) {
      throw new Error(`INSERT for meta-index returned no rows — check DB permissions`);
    }
    indexNodeId = result.rows[0].id;
  } else {
    indexNodeId = indexNodes[0]!.id;
  }

  // Skip if already registered (check both node AND edge to avoid stale-edge false positives)
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM kg_nodes n
     JOIN kg_edges e ON e.target_node_id = n.id
     WHERE e.source_node_id = $1
       AND n.label = $2
       AND n.archived_at IS NULL
       AND e.archived_at IS NULL`,
    [indexNodeId, namespace],
  );
  if (parseInt(existing.rows[0]?.count ?? '0', 10) > 0) return;

  const factResult = await db.query<{ id: string }>(
    `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, sensitivity)
     VALUES ('fact', $1, $2, 1.0, 'permanent', 'migration:knowledge-to-config-store', 'internal')
     RETURNING id`,
    [namespace, JSON.stringify({ namespace })],
  );
  if (!factResult.rows[0]) {
    throw new Error(`INSERT for namespace index fact "${namespace}" returned no rows`);
  }
  const factId = factResult.rows[0].id;

  await db.query(
    `INSERT INTO kg_edges (source_node_id, target_node_id, type, properties, confidence, decay_class, source)
     VALUES ($1, $2, 'relates_to', '{}', 1.0, 'permanent', 'migration:knowledge-to-config-store')`,
    [indexNodeId, factId],
  );
}

/**
 * Determine whether a config entry would be created or updated (used by both
 * dry-run and the real write path).
 */
async function existingFactId(db: Queryable, anchorId: string, key: string): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT n.id
     FROM kg_nodes n
     JOIN kg_edges e ON e.target_node_id = n.id
     WHERE e.source_node_id = $1
       AND n.label = $2
       AND n.type = 'fact'
       AND n.archived_at IS NULL
       AND e.archived_at IS NULL
     LIMIT 1`,
    [anchorId, key],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Write one config-store entry (key/value) under a namespace anchor.
 * Uses label-based dedup: if a fact with this key already exists, update it.
 */
async function writeConfigEntry(
  db: Queryable,
  anchorId: string,
  entry: ConfigEntry,
): Promise<'created' | 'updated'> {
  const properties = JSON.stringify({ key: entry.key, value: entry.value, namespace: entry.namespace });
  const existingId = await existingFactId(db, anchorId, entry.key);

  if (existingId) {
    await db.query(
      `UPDATE kg_nodes SET properties = $1, last_confirmed_at = now() WHERE id = $2`,
      [properties, existingId],
    );
    return 'updated';
  }

  const factResult = await db.query<{ id: string }>(
    `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, sensitivity)
     VALUES ('fact', $1, $2, 1.0, 'permanent', 'migration:knowledge-to-config-store', 'internal')
     RETURNING id`,
    [entry.key, properties],
  );
  if (!factResult.rows[0]) {
    throw new Error(`INSERT for fact "${entry.key}" in namespace "${entry.namespace}" returned no rows`);
  }
  const factId = factResult.rows[0].id;

  await db.query(
    `INSERT INTO kg_edges (source_node_id, target_node_id, type, properties, confidence, decay_class, source)
     VALUES ($1, $2, 'relates_to', '{}', 1.0, 'permanent', 'migration:knowledge-to-config-store')`,
    [anchorId, factId],
  );
  return 'created';
}

// -- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log(`migrate-knowledge-skills-to-config-store${DRY_RUN ? ' (dry run)' : ''}`);
    console.log('='.repeat(60));

    // Collect all migration work: read old data and plan writes
    const plan: Array<{
      migration: (typeof MIGRATIONS)[number];
      entries: ConfigEntry[];
      anchors: KgNode[];
    }> = [];

    for (const migration of MIGRATIONS) {
      const { oldAnchorLabel, namespace, transform } = migration;
      console.log(`\n[${oldAnchorLabel}] → namespace "${namespace}"`);

      const anchors = await findNodesByLabel(pool, oldAnchorLabel);
      if (anchors.length === 0) {
        console.log('  No anchor node found — nothing to migrate.');
        continue;
      }

      const allFacts: KgNode[] = [];
      for (const anchor of anchors) {
        const facts = await getFacts(pool, anchor.id);
        allFacts.push(...facts);
      }

      if (allFacts.length === 0) {
        console.log(`  Anchor exists (${anchors.length} node(s)) but has no facts — nothing to migrate.`);
        continue;
      }

      console.log(`  Found ${allFacts.length} fact(s) across ${anchors.length} anchor node(s).`);

      const entries: ConfigEntry[] = [];
      for (const fact of allFacts) {
        const entry = transform(fact);
        if (!entry) {
          console.log(`  SKIP: fact "${fact.label}" has no transformable data — skipping.`);
          continue;
        }
        entries.push(entry);
      }

      plan.push({ migration, entries, anchors });
    }

    // Dry-run: show create-vs-update breakdown without writing anything
    if (DRY_RUN) {
      console.log('\n' + '='.repeat(60));
      console.log('Dry run — checking what would be written:\n');
      let totalCreate = 0;
      let totalUpdate = 0;

      for (const { migration, entries } of plan) {
        // Check whether the config-store anchor already exists (read-only)
        const existingAnchor = await findNodesByLabel(pool, anchorLabel(migration.namespace));
        const anchorStatus = existingAnchor.length > 0 ? 'anchor exists' : 'anchor would be created';
        console.log(`[${migration.namespace}] ${anchorStatus}`);

        if (existingAnchor.length > 0) {
          for (const entry of entries) {
            const existId = await existingFactId(pool, existingAnchor[0]!.id, entry.key);
            const action = existId ? 'UPDATE' : 'CREATE';
            if (action === 'CREATE') totalCreate++;
            else totalUpdate++;
            console.log(`  [${action}] key="${entry.key}", value=${JSON.stringify(entry.value).slice(0, 80)}`);
          }
        } else {
          for (const entry of entries) {
            totalCreate++;
            console.log(`  [CREATE] key="${entry.key}", value=${JSON.stringify(entry.value).slice(0, 80)}`);
          }
        }
      }

      console.log('\n' + '='.repeat(60));
      console.log(`Dry run complete. Would create: ${totalCreate}, would update: ${totalUpdate}. No data written.`);
      return;
    }

    // Real run: wrap all writes in a single transaction for atomicity
    const client = await pool.connect();
    let totalMigrated = 0;
    let totalUpdated = 0;

    try {
      await client.query('BEGIN');

      for (const { migration, entries } of plan) {
        const { namespace } = migration;
        const anchorId = await upsertConfigAnchor(client, namespace);
        await registerNamespace(client, namespace);

        for (const entry of entries) {
          const action = await writeConfigEntry(client, anchorId, entry);
          console.log(`  ${action === 'created' ? 'WROTE  ' : 'UPDATED'}: [${namespace}] key="${entry.key}", value=${JSON.stringify(entry.value).slice(0, 80)}`);
          if (action === 'created') totalMigrated++;
          else totalUpdated++;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Done. Created: ${totalMigrated}, Updated: ${totalUpdated}.`);
  } finally {
    // Guard: if pool.end() itself fails, log but don't mask the original error
    await pool.end().catch((endErr: unknown) => {
      console.error('Warning: pool.end() failed:', endErr);
    });
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
