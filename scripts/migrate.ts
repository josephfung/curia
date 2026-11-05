// migrate.ts — apply pending database migrations on both tracks (#2465, ADR-061): upstream
// (src/db/migrations → pgmigrations), then local (src/db/migrations-local or
// CURIA_LOCAL_MIGRATIONS_DIR → pgmigrations_local). Boot runs the same helper.
//
//   pnpm migrate              # apply; exits 1 on any failure
//   pnpm migrate --dry-run    # show what boot would do; writes nothing
//
// Dry-run exit codes: 0 boot would go ahead; 1 boot would stop (the report says why);
// 2 boot would go ahead but the report has warnings (objects created on both tracks);
// 3 the dry run itself failed (bad arguments, no DATABASE_URL, can't connect).
//
// In the container (install.sh): ./node_modules/.bin/tsx scripts/migrate.ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import {
  dryRunExitCode,
  dryRunReconciliation,
  formatDryRunReport,
  MigrationReconciliationError,
  resolveMigrationDirs,
  runMigrations,
} from '../src/db/run-migrations.js';

const logger = pino({ name: 'migrate' });
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DRY_RUN_FAILED = 3;

async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const failed = dryRun ? DRY_RUN_FAILED : 1;
  const unknown = argv.filter(arg => arg !== '--dry-run');
  if (unknown.length > 0) {
    logger.error({ unknown }, 'migrate: unknown argument (the only option is --dry-run)');
    return failed;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('migrate: DATABASE_URL is not set');
    return failed;
  }
  const dirs = resolveMigrationDirs(PROJECT_ROOT);

  if (dryRun) {
    try {
      const report = await dryRunReconciliation(databaseUrl, dirs);
      process.stdout.write(`${formatDryRunReport(report)}\n`);
      return dryRunExitCode(report);
    } catch (err) {
      logger.error({ err }, 'migrate: dry run failed');
      return DRY_RUN_FAILED;
    }
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
  logger.info(
    { upstream: result.upstream.length, local: result.local.length, localTrackInUse: result.localTrackInUse, localDir: result.localDir },
    'migrate: done',
  );
  return 0;
}

// CLI entry — only when executed directly (not when imported by tests).
// Sets exitCode rather than calling process.exit(), which can cut off stdout still being
// written to a pipe — and the end of a dry-run report is where the reasons are.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch((err: unknown) => {
      // The refusal lists what to fix, one reason per line; JSON-escaping it would bury that.
      if (err instanceof MigrationReconciliationError) process.stderr.write(`${err.message}\n`);
      logger.error({ err }, 'migrate: failed');
      process.exitCode = 1;
    });
}
