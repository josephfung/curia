// migrate.ts — apply pending database migrations on both tracks (#2465, ADR-061): upstream
// (src/db/migrations → pgmigrations), then local (src/db/migrations-local or
// CURIA_LOCAL_MIGRATIONS_DIR → pgmigrations_local). Boot runs the same helper.
//
//   pnpm migrate              # apply
//   pnpm migrate --dry-run    # show what reconciling a fork's history would do; writes nothing
//
// In the container (install.sh): ./node_modules/.bin/tsx scripts/migrate.ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import {
  dryRunReconciliation,
  formatDryRunReport,
  MigrationReconciliationError,
  resolveMigrationDirs,
  runMigrations,
} from '../src/db/run-migrations.js';

const logger = pino({ name: 'migrate' });
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

async function main(argv: string[]): Promise<number> {
  const unknown = argv.filter(arg => arg !== '--dry-run');
  if (unknown.length > 0) {
    logger.error({ unknown }, 'migrate: unknown argument (the only option is --dry-run)');
    return 1;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('migrate: DATABASE_URL is not set');
    return 1;
  }
  const dirs = resolveMigrationDirs(PROJECT_ROOT);

  if (argv.includes('--dry-run')) {
    const report = await dryRunReconciliation(databaseUrl, dirs);
    process.stdout.write(`${formatDryRunReport(report)}\n`);
    return report.plan.refusals.length > 0 ? 1 : 0;
  }

  const result = await runMigrations({
    databaseUrl,
    dirs,
    log: message => process.stdout.write(`${message}\n`),
  });
  if (result.moved.length > 0) {
    logger.info({ moved: result.moved }, 'migrate: moved fork migrations to pgmigrations_local');
  }
  // node-pg-migrate has already printed each migration it ran; the counts are the summary.
  logger.info({ upstream: result.upstream.length, local: result.local.length }, 'migrate: done');
  return 0;
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      // The refusal lists what to fix, one reason per line; JSON-escaping it would bury that.
      if (err instanceof MigrationReconciliationError) process.stderr.write(`${err.message}\n`);
      logger.error({ err }, 'migrate: failed');
      process.exit(1);
    });
}
