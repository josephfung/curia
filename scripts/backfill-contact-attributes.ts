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
  confidence: number;
  last_confirmed_at: string | null;
};

export async function runBackfill(pool: pg.Pool): Promise<{
  processed: number;
  written: number;
  skipped: number;
  errors: number;
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
  let written = 0;
  let skipped = 0;
  let errors = 0;

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
           (e.source_id = $1 AND e.target_id = n.id)
           OR (e.target_id = $1 AND e.source_id = n.id)
         )
         WHERE e.relationship = 'relates_to'
           AND n.type = 'fact'`,
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
        params.push(val);
        setClauses.push(`${col} = $${params.length}`);
      }

      await pool.query(
        `UPDATE contacts SET ${setClauses.join(', ')} WHERE id = $1`,
        params,
      );

      written += Object.keys(updates).length;
      processed++;
      console.log(
        `[backfill] contact ${contact.id}: wrote ${Object.keys(updates).join(', ')}`,
      );
    } catch (err) {
      console.error(`[backfill] contact ${contact.id} failed:`, err);
      errors++;
    }
  }

  console.log(
    `[backfill] done — processed: ${processed}, written: ${written}, skipped: ${skipped}, errors: ${errors}`,
  );
  return { processed, written, skipped, errors };
}

// CLI entry point — only runs when executed directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[backfill] DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl });
  runBackfill(pool)
    .then(({ errors }) => {
      void pool.end();
      process.exit(errors > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('[backfill] fatal error:', err);
      void pool.end();
      process.exit(1);
    });
}
