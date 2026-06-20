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
type ServiceLike = Pick<ContactService, 'listContacts' | 'elevateTierToKnown' | 'getContact'>;
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
  //    so the subsequent listContacts() query sees fresh data. It catches and logs
  //    per-contact failures internally rather than throwing, so we fold its `failed`
  //    count into our own `errors` — otherwise a silent recompute failure would let
  //    the script exit 0. A *fatal* pipeline failure (e.g. the initial listContacts)
  //    still throws; we log and re-throw to the CLI entry (exits 1).
  let recomputed: number;
  let errors = 0;
  try {
    const result = await pipeline.fullRecomputeAll();
    recomputed = result.recomputed;
    errors += result.failed;
  } catch (err) {
    logger.error({ err }, 'rederive: fullRecomputeAll failed, aborting');
    throw err;
  }

  // 2. Re-list unknown-tier person/org contacts (post-recompute snapshot) and
  //    elevate those over the judgment threshold.
  //    Same guard: a DB failure here is fatal — re-throw so the CLI exits 1.
  let candidates: Awaited<ReturnType<ServiceLike['listContacts']>>;
  try {
    candidates = await contactService.listContacts({
      tier: 'unknown',
      kind: ['person', 'organization'],
    });
  } catch (err) {
    logger.error({ err }, 'rederive: listContacts failed, aborting after recompute');
    throw err;
  }

  let elevated = 0;
  let skipped = 0;
  // `errors` already carries any fullRecomputeAll failures from step 1; the per-candidate
  // loop below adds to it.
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
          // elevateTierToKnown returns false BOTH for a benign no-op (already
          // known/trusted) AND for a swallowed backend failure — it catches and
          // logs internally, so a false here is ambiguous. We listed this contact
          // as 'unknown' and it just cleared the threshold, so it *should* now be
          // elevated. Re-read the authoritative tier to disambiguate: still
          // 'unknown' means the elevation really failed (count as an error so the
          // exit code is honest), anything else is a benign concurrent no-op.
          const after = await contactService.getContact(c.id);
          if (after && after.tier === 'unknown') {
            logger.error(
              { contactId: c.id },
              'rederive: elevation returned false and contact is still unknown — treating as failure',
            );
            errors++;
            failedContactIds.push(c.id);
          } else {
            skipped++;
          }
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

  const summary = { recomputed, elevated, skipped, errors, failedContactIds };
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
  // Single async control path: try runs the migration, catch normalizes the fatal
  // exit, finally guarantees the pool is closed exactly once on every path.
  const main = async (): Promise<void> => {
    const pool = new Pool({ connectionString: databaseUrl });
    let exitCode = 0;
    try {
      const contactService = ContactService.createWithPostgres(pool, undefined, logger);
      const pipeline = new ConfidencePipeline(contactService, logger);
      const { errors } = await runRederive(contactService, pipeline);
      exitCode = errors > 0 ? 1 : 0;
    } catch (err) {
      logger.error({ err }, 'rederive: fatal error');
      exitCode = 1;
    } finally {
      await pool.end();
    }
    process.exit(exitCode);
  };
  await main();
}
