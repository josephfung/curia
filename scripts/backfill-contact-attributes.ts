// scripts/backfill-contact-attributes.ts
//
// Backfills contact canonical columns from KG fact nodes.
// Each contact's kg_node_id is used to find related fact nodes via
// 'relates_to' edges. For each NULL column, the fact with the highest
// confidence (tiebreak: most recent last_confirmed_at) is written.
//
// Run: pnpm run backfill:contact-attributes
// Safety: idempotent — only writes to NULL columns.

import pg from 'pg';
import pino from 'pino';

const logger = pino({ name: 'backfill-contact-attributes' });

const { Pool } = pg;

// Mapping from KG fact attribute keys to contact columns.
// Keys are compared case-insensitively.
const ATTRIBUTE_MAP: Record<string, string> = {
  preferred_name: 'preferred_name',
  nickname: 'preferred_name',
  job_title: 'title',
  title: 'title',
  // 'role' maps to title only when contact.system_role IS NULL (handled in code)
  organization: 'organization',
  employer: 'organization',
  company: 'organization',
  current_employer: 'organization',
  email: 'primary_email',
  primary_email: 'primary_email',
  phone: 'primary_phone',
  phone_number: 'primary_phone',
  mobile: 'primary_phone',
  timezone: 'timezone',
  tz: 'timezone',
  locale: 'locale',
  language: 'locale',
  home_city: 'location',
  current_location: 'location',
  location: 'location',
  city: 'location',
  pronouns: 'pronouns',
  linkedin: 'linkedin_url',
  linkedin_url: 'linkedin_url',
  bio: 'bio',
  biography: 'bio',
  birthday: 'birthday',
  birthdate: 'birthday',
  dob: 'birthday',
};

// All 12 canonical column names (snake_case, matching DB columns).
const CANONICAL_COLUMNS = [
  'preferred_name', 'title', 'organization', 'primary_email', 'primary_phone',
  'timezone', 'locale', 'location', 'pronouns', 'linkedin_url', 'bio', 'birthday',
];

type ContactRowForBackfill = {
  id: string;
  kg_node_id: string | null;
  system_role: string | null;
  preferred_name: string | null;
  title: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedin_url: string | null;
  bio: string | null;
  birthday: string | null;
};

type FactRow = {
  id: string;
  properties: { attribute?: string; value?: string };
  // node-pg returns NUMERIC as string at runtime; Number() coercion is applied at use site
  confidence: string;
  last_confirmed_at: string | null;
};

export async function runBackfill(pool: pg.Pool): Promise<{
  processed: number;
  columnsWritten: number;
  skipped: number;
  errors: number;
  failedContactIds: string[];
}> {
  // Fetch all contacts that have a KG node linked.
  const contactsResult = await pool.query<ContactRowForBackfill>(
    `SELECT id, kg_node_id, system_role,
            preferred_name, title, organization, primary_email, primary_phone,
            timezone, locale, location, pronouns, linkedin_url, bio, birthday
     FROM contacts WHERE kg_node_id IS NOT NULL`,
  );

  const contacts = contactsResult.rows;
  let processed = 0;
  let columnsWritten = 0;
  // skipped counts columns that already had a non-null value and were left untouched
  let skipped = 0;
  let errors = 0;
  const failedContactIds: string[] = [];

  for (const contact of contacts) {
    // Guard against null kg_node_id entries (defensive — the query filters these,
    // but mocks or callers might not).
    if (!contact.kg_node_id) continue;

    try {
      // Fetch all fact nodes reachable via a single 'relates_to' edge
      // from this contact's KG person node (either direction).
      const factsResult = await pool.query<FactRow>(
        `SELECT n.id, n.properties, n.confidence, n.last_confirmed_at
         FROM kg_nodes n
         JOIN kg_edges e ON (
           (e.source_node_id = $1 AND e.target_node_id = n.id)
           OR (e.target_node_id = $1 AND e.source_node_id = n.id)
         )
         WHERE e.type = 'relates_to'
           AND e.archived_at IS NULL
           AND n.type = 'fact'
           AND n.archived_at IS NULL`,
        [contact.kg_node_id],
      );

      const facts = factsResult.rows;

      // Group facts by target column. For each column collect all candidates,
      // then pick the one with highest confidence (tiebreak: most recent last_confirmed_at).
      const candidates: Record<string, Array<{ value: string; confidence: number; confirmedAt: number }>> = {};

      for (const fact of facts) {
        const attrRaw = fact.properties?.attribute;
        const value = fact.properties?.value;
        if (!attrRaw || !value) continue;

        const attr = attrRaw.toLowerCase();

        // 'role' only maps to 'title' when system_role IS NULL
        if (attr === 'role' && contact.system_role != null) continue;

        const col = attr === 'role' ? 'title' : ATTRIBUTE_MAP[attr];
        if (!col) continue;

        const confirmedAt = fact.last_confirmed_at
          ? new Date(fact.last_confirmed_at).getTime()
          : 0;

        if (!candidates[col]) candidates[col] = [];
        candidates[col].push({ value, confidence: Number(fact.confidence), confirmedAt });
      }

      // Determine which NULL columns have a candidate value.
      const updates: Record<string, string> = {};
      for (const col of CANONICAL_COLUMNS) {
        // Only write to NULL columns (idempotent safety)
        if (contact[col as keyof ContactRowForBackfill] != null) {
          skipped++;
          continue;
        }

        const colCandidates = candidates[col];
        if (!colCandidates || colCandidates.length === 0) continue;

        // Sort: highest confidence first; tiebreak on most recent last_confirmed_at
        colCandidates.sort((a, b) =>
          b.confidence !== a.confidence
            ? b.confidence - a.confidence
            : b.confirmedAt - a.confirmedAt,
        );

        updates[col] = colCandidates[0]!.value;
      }

      if (Object.keys(updates).length === 0) {
        processed++;
        continue;
      }

      // Build a parameterized UPDATE for only the changed columns.
      const setClauses: string[] = [];
      const params: unknown[] = [contact.id];
      for (const [col, val] of Object.entries(updates)) {
        // col is always a CANONICAL_COLUMNS member by construction; guard against future drift
        if (!CANONICAL_COLUMNS.includes(col)) {
          throw new Error(`[backfill] refusing to interpolate unknown column: ${col}`);
        }
        params.push(val);
        setClauses.push(`${col} = $${params.length}`);
      }

      await pool.query(
        `UPDATE contacts SET ${setClauses.join(', ')} WHERE id = $1`,
        params,
      );

      columnsWritten += Object.keys(updates).length;
      processed++;
      logger.info({ contactId: contact.id, columns: Object.keys(updates) }, 'backfill: wrote columns');
    } catch (err) {
      logger.error({ contactId: contact.id, err }, 'backfill: contact failed');
      errors++;
      failedContactIds.push(contact.id);
    }
  }

  logger.info({ processed, columnsWritten, skipped, errors, failedContactIds }, 'backfill: done');
  return { processed, columnsWritten, skipped, errors, failedContactIds };
}

// CLI entry point — only runs when executed directly
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    logger.error('backfill: DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl });
  runBackfill(pool)
    .then(async ({ errors }) => {
      await pool.end();
      process.exit(errors > 0 ? 1 : 0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'backfill: fatal error');
      await pool.end();
      process.exit(1);
    });
}
