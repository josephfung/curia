// scripts/rederive-contact-tiers.ts
//
// One-shot re-derivation of contact tiers from correspondence history (#955).
// Recomputes contact_confidence for every contact, then elevates unknown→known
// for person/org contacts whose recomputed confidence clears the judgment
// elevation threshold — the retroactive equivalent of the live dispatcher's
// judgment elevation. 'trusted' is a grant decision (#952), not re-derived here.
//
// Run: pnpm run rederive:contact-tiers
// Safety: idempotent — re-running elevates nothing once scores are stable.

import pg from 'pg';
import pino from 'pino';
import { ContactService } from '../src/contacts/contact-service.js';
import { ConfidencePipeline } from '../src/contacts/confidence-pipeline.js';
import { JUDGMENT_ELEVATION_THRESHOLD } from '../src/contacts/confidence-scorer.js';

const logger = pino({ name: 'rederive-contact-tiers' });
const { Pool } = pg;

// Structural aliases used by runRederive so tests can pass minimal mocks
// without depending on the full ContactService / ConfidencePipeline shapes.
type ServiceLike = Pick<ContactService, 'listContacts' | 'elevateTierToKnown'>;
type PipelineLike = Pick<ConfidencePipeline, 'fullRecomputeAll' | 'fullRecompute'>;

export async function runRederive(
  contactService: ServiceLike,
  pipeline: PipelineLike,
): Promise<{
  recomputed: number;
  elevated: number;
  skipped: number;
  errors: number;
  failedContactIds: string[];
}> {
  // 1. Refresh every contact's confidence from current correspondence stats.
  //    fullRecomputeAll() iterates all contacts and persists updated scores,
  //    so the subsequent listContacts() query sees fresh data.
  await pipeline.fullRecomputeAll();

  // 2. Re-list unknown-tier person/org contacts (post-recompute snapshot) and
  //    elevate those over the judgment threshold.
  const candidates = await contactService.listContacts({
    tier: 'unknown',
    kind: ['person', 'organization'],
  });

  let elevated = 0;
  let skipped = 0;
  let errors = 0;
  const failedContactIds: string[] = [];

  for (const c of candidates) {
    try {
      // fullRecompute re-persists and returns the latest confidence score.
      // We call it again per candidate (rather than trusting the listed snapshot)
      // to pick up any race-condition writes that landed between fullRecomputeAll
      // and the listContacts query — and to get a clean authoritative value.
      const confidence = await pipeline.fullRecompute(c.id);

      if (confidence >= JUDGMENT_ELEVATION_THRESHOLD) {
        const didElevate = await contactService.elevateTierToKnown(c.id, 'judgment');
        if (didElevate) {
          elevated++;
        } else {
          // elevateTierToKnown returns false when the contact is already known/trusted
          // or the update was a no-op — treat as a successful skip, not an error.
          skipped++;
        }
      } else {
        skipped++;
      }
    } catch (err) {
      logger.error({ contactId: c.id, err }, 'rederive: contact failed');
      errors++;
      failedContactIds.push(c.id);
    }
  }

  const summary = { recomputed: candidates.length, elevated, skipped, errors, failedContactIds };
  logger.info(summary, 'rederive: done');
  return summary;
}

// CLI entry point — only runs when executed directly (not when imported by tests)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    logger.error('rederive: DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const contactService = ContactService.createWithPostgres(pool, undefined, logger);
  const pipeline = new ConfidencePipeline(contactService, logger);
  runRederive(contactService, pipeline)
    .then(async ({ errors }) => {
      await pool.end();
      process.exit(errors > 0 ? 1 : 0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'rederive: fatal error');
      await pool.end();
      process.exit(1);
    });
}
