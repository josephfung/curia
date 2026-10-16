// tests/setup-wizard/cli.ts — drive the /setup wizard end to end in a real browser (#2146).
//
// `pnpm e2e:setup-wizard [--port <n>] [--headed] [--chromium <path>] [--skip-build] [--keep-db] [--allow-remote-db]`
//
// Does what a fresh operator install does, then clicks through the wizard the way a
// person would:
//
//   1. Creates an EMPTY database `<source>_wizard_<pid>` on DATABASE_URL's server,
//      migrates it and seeds the vault with throwaway secrets (a fresh encryption key,
//      bootstrap secret and API token; a placeholder Anthropic key).
//   2. Builds the console (skip with --skip-build) and boots Curia on --port (default
//      3099), so it comes up in setup-required mode exactly like a new install.
//   3. Signs in with the bootstrap secret and completes all six steps, asserting each
//      step's URL and "Step N of 6" label, then confirms on the Review step.
//   4. Plays supervisor: `/api/setup/restart` exits the process (Docker's restart policy
//      brings it back in production), so the script restarts it once, then waits for
//      the wizard to land on /chat.
//   5. Reads the saved state back over the API and checks every choice made in steps
//      1–5 reached the backend, and that Curia left setup mode.
//
// Exits 1 on any failure, leaving a screenshot and the server log path in the output.
// The database is dropped afterwards (Ctrl-C included) unless --keep-db; one left by a
// run that was killed outright is swept by the next run.
//
// The npm script launches this with `node --import tsx`, not the `tsx` CLI: the CLI's
// parent process relays Ctrl-C and SIGKILLs a child that is still cleaning up ~30ms
// later, which would leave the database behind.
//
// The placeholder Anthropic key means the wizard's name suggestion and the /chat
// kickoff message fail. Both are expected: the wizard must cope with the first, and the
// walkthrough only asserts that /chat is reached, not what the agent says there.
//
// Run before every release cut (CLAUDE.md pre-flight C) and whenever the wizard, the
// /setup route or the setup API changes. Needs a local Postgres with pgvector and
// Playwright's Chromium; docs/dev/setup-wizard-e2e.md has the details.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { runner } from 'node-pg-migrate';
import { chromium, type Browser, type Page } from 'playwright';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { seedVault, verifyRequiredSecrets } from '../../scripts/seed-vault.js';
import { databaseName, isLocalDatabase, likePrefix } from '../smoke/clone-db.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'src', 'db', 'migrations');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/** Must match the wizard: a run that sees a different count is testing a different wizard. */
const EXPECTED_TOTAL_STEPS = 6;
/** First boot runs every migration; generous so a slow laptop isn't a false failure. */
const BOOT_TIMEOUT_MS = 180_000;
/** Covers the restart: process exit, re-boot, then the wizard's 2s status poll. */
const FINISH_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 15_000;
/** The wizard needs one; a process that keeps exiting 0 is a boot loop, not a restart. */
const MAX_RESTARTS = 3;

/** What the walkthrough enters. Every value differs from the wizard's defaults so a dropped field shows. */
const INPUT = {
  principalName: 'Wizard Walkthrough Principal',
  timezone: 'Europe/Lisbon',
  email: 'walkthrough@example.com',
  preferredName: 'Walker',
  principalTitle: 'Chief Testing Officer',
  assistantName: 'Robin Curia',
  assistantTitle: 'Walkthrough EA',
  // The wizard starts on ['warm', 'direct']: drop warm, add calm and witty.
  toneRemove: 'warm',
  toneAdd: ['calm', 'witty'],
  expectedTone: ['direct', 'calm', 'witty'],
  posture: { title: 'Proactive', value: 'proactive' },
} as const;

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const err = (line: string): void => { process.stderr.write(`${line}\n`); };

// ── Arguments ────────────────────────────────────────────────────────────────

interface WizardArgs {
  port: number;
  headed: boolean;
  /** A Chromium binary to use instead of Playwright's own download. */
  chromium?: string;
  skipBuild: boolean;
  keepDb: boolean;
  allowRemoteDb: boolean;
}

// Strict, like smoke's: a typo'd flag must not quietly run a different walkthrough.
function parseArgs(argv: string[]): WizardArgs {
  const args: WizardArgs = { port: 3099, headed: false, skipBuild: false, keepDb: false, allowRemoteDb: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag.includes('=')) throw new Error(`write '${flag.split('=')[0]} <value>', not '${flag}'`);
    if (flag === '--headed') args.headed = true;
    else if (flag === '--skip-build') args.skipBuild = true;
    else if (flag === '--keep-db') args.keepDb = true;
    else if (flag === '--allow-remote-db') args.allowRemoteDb = true;
    else if (flag === '--port') {
      const value = argv[++i];
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port needs a port number, got '${value ?? ''}'`);
      args.port = port;
    } else if (flag === '--chromium') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error('--chromium needs a path');
      args.chromium = value;
    } else {
      throw new Error(`unknown argument '${flag}' — expected --port, --headed, --chromium, --skip-build, --keep-db or --allow-remote-db`);
    }
  }
  return args;
}

// ── Throwaway database ───────────────────────────────────────────────────────

function withDatabase(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin<T>(databaseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(databaseUrl, 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const WIZARD_INFIX = '_wizard_';

/** Whether a process with this pid is running on this machine. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else — still alive, so leave its database.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Drops databases left by runs that died without cleaning up (SIGKILL, a crash, a closed
 * terminal). Each is named after its run's pid; a live pid is a parallel run, so it stays.
 * Returns the names dropped.
 */
async function sweepStaleDatabases(sourceUrl: string): Promise<string[]> {
  const prefix = `${databaseName(sourceUrl)}${WIZARD_INFIX}`;
  return withAdmin(sourceUrl, async client => {
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [likePrefix(prefix)],
    );
    const dropped: string[] = [];
    for (const { datname } of rows) {
      const pid = datname.slice(prefix.length);
      // Exactly `<prefix><digits>`, so a database someone named by hand is never touched.
      if (!/^\d+$/.test(pid) || isAlive(Number(pid))) continue;
      await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      dropped.push(datname);
    }
    return dropped;
  });
}

/** Creates an empty database; the name is validated by databaseName() and the pid, so quoting is safe. */
async function createEmptyDatabase(sourceUrl: string): Promise<{ url: string; name: string; drop: () => Promise<void> }> {
  const name = `${databaseName(sourceUrl)}${WIZARD_INFIX}${process.pid}`;
  if (name.length > 63) throw new Error(`database name '${name}' exceeds Postgres's 63-character limit`);
  await withAdmin(sourceUrl, async client => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  });
  let dropped = false;
  return {
    url: withDatabase(sourceUrl, name),
    name,
    drop: async () => {
      if (dropped) return;
      dropped = true;
      await withAdmin(sourceUrl, client => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

interface Secrets {
  encryptionKey: string;
  bootstrapSecret: string;
  apiToken: string;
}

async function prepareDatabase(databaseUrl: string, secrets: Secrets): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => { /* the count is reported below; per-migration lines are noise here */ },
  });
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const logger = pino({ level: 'warn' });
    const vault = new SecretsService(pool, Buffer.from(secrets.encryptionKey, 'base64'), logger);
    // Same seeding path as install.sh and setup.sh, fed a synthetic env.
    await seedVault(vault, {
      ANTHROPIC_API_KEY: 'sk-ant-setup-wizard-walkthrough-placeholder',
      API_TOKEN: secrets.apiToken,
      WEB_APP_BOOTSTRAP_SECRET: secrets.bootstrapSecret,
    }, logger, { only: new Set(['anthropic_api_key', 'api_token', 'web_app_bootstrap_secret']) });
    const missing = await verifyRequiredSecrets(vault, logger);
    if (missing.length > 0) throw new Error(`vault seeding left required secrets missing: ${missing.join(', ')}`);
  } finally {
    await pool.end();
  }
}

// ── Curia process (the script is its supervisor) ─────────────────────────────

class CuriaProcess {
  private child: ChildProcess | null = null;
  private readonly log: WriteStream;
  private stopping = false;
  /** Clean exits that were followed by a restart, i.e. what Docker's restart policy would do. */
  restarts = 0;
  /** Set when the process dies in a way a supervisor would not paper over. */
  crashed: string | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv, readonly logPath: string) {
    this.log = createWriteStream(logPath, { flags: 'a' });
  }

  start(): void {
    const child = spawn(TSX_BIN, ['src/index.ts'], { cwd: REPO_ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(this.log, { end: false });
    child.stderr?.pipe(this.log, { end: false });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      if (code === 0 && this.restarts < MAX_RESTARTS) {
        // /api/setup/restart exits 0 on purpose and relies on a supervisor.
        this.restarts++;
        this.log.write(`\n--- setup-wizard e2e: process exited 0, restarting (restart #${this.restarts}) ---\n\n`);
        this.start();
      } else {
        this.crashed = `Curia exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
      }
    });
    this.child = child;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    this.log.end();
  }
}

async function waitForSetupApi(baseUrl: string, secret: string, curia: CuriaProcess): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (curia.crashed) throw new Error(`${curia.crashed} before the setup API came up`);
    try {
      const res = await fetch(`${baseUrl}/api/setup/status`, { headers: { 'x-web-bootstrap-secret': secret } });
      if (res.ok) return;
    } catch {
      // Not listening yet — keep polling until the deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Curia did not serve /api/setup/status within ${BOOT_TIMEOUT_MS / 1000}s`);
}

// ── The walkthrough ──────────────────────────────────────────────────────────

async function expectStep(page: Page, step: number, heading: string): Promise<void> {
  try {
    // The URL check is the one #2146 needed: the route silently clamped ?step=6 to 5.
    await page.waitForURL(url => url.pathname === '/setup' && url.searchParams.get('step') === String(step), { timeout: STEP_TIMEOUT_MS });
    await page.getByText(`Step ${step} of ${EXPECTED_TOTAL_STEPS}`, { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.locator('.wizard-heading', { hasText: heading }).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (e) {
    const firstLine = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    throw new Error(`did not reach step ${step} ("${heading}") — still on ${new URL(page.url()).search || page.url()}. ${firstLine}`);
  }
  out(`  ✓ step ${step}: ${heading}`);
}

async function walkThroughWizard(page: Page, baseUrl: string, secret: string, curia: CuriaProcess): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await page.getByPlaceholder('Access key').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // A fresh install has no configured identity, so the router sends the operator to step 1.
  await expectStep(page, 1, 'Tell us about yourself');
  await page.locator('#w-principal-name').fill(INPUT.principalName);
  await page.locator('.btn-wizard-next').click();

  await expectStep(page, 2, 'Your details');
  await page.locator('#w-timezone').selectOption(INPUT.timezone);
  await page.locator('#w-profile-email').fill(INPUT.email);
  await page.locator('#w-preferred-name').fill(INPUT.preferredName);
  await page.locator('#w-principal-title').fill(INPUT.principalTitle);
  await page.locator('.btn-wizard-next').click();

  await expectStep(page, 3, 'What should your assistant be called?');
  await page.locator('#w-name').fill(INPUT.assistantName);
  await page.locator('#w-title').fill(INPUT.assistantTitle);
  await page.locator('.btn-wizard-next').click();

  await expectStep(page, 4, 'How should your assistant communicate?');
  await page.locator('.tone-pill', { hasText: new RegExp(`^${INPUT.toneRemove}$`) }).click();
  for (const word of INPUT.toneAdd) {
    await page.locator('.tone-pill', { hasText: new RegExp(`^${word}$`) }).click();
  }
  await page.locator('.btn-wizard-next').click();

  await expectStep(page, 5, 'How should your assistant decide?');
  await page.getByRole('radio', { name: new RegExp(INPUT.posture.title) }).click();
  await page.locator('.btn-wizard-next').click();

  await expectStep(page, 6, 'Does everything look right?');
  const review = await page.locator('.review-card').innerText();
  for (const expected of [INPUT.assistantName, INPUT.assistantTitle, ...INPUT.expectedTone]) {
    if (!review.includes(expected)) throw new Error(`Review step is missing '${expected}':\n${review}`);
  }
  await page.getByRole('button', { name: 'Confirm & save' }).click();
  out('  ✓ confirmed on the review step; waiting for the restart and /chat');

  const deadline = Date.now() + FINISH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (curia.crashed) throw new Error(`${curia.crashed} after the wizard was confirmed`);
    if (new URL(page.url()).pathname === '/chat') break;
    const failure = await page.locator('.wizard-submit-error').textContent({ timeout: 1 }).catch(() => null);
    if (failure) throw new Error(`Saving failed on the review step: ${failure}`);
    if (await page.getByText("Curia didn't come back yet").isVisible()) {
      throw new Error('The wizard timed out waiting for Curia to come back after the restart');
    }
    await page.waitForTimeout(500);
  }
  if (new URL(page.url()).pathname !== '/chat') throw new Error(`The wizard did not reach /chat within ${FINISH_TIMEOUT_MS / 1000}s`);
  out('  ✓ landed on /chat');
}

interface IdentityResponse {
  configured: boolean;
  identity: {
    assistant: { name: string; title: string };
    tone: { baseline: string[] };
    decisionStyle: { externalActions: string };
  };
}
interface StatusResponse { principalExists: boolean; identityConfigured: boolean; externalAdaptersPending: boolean }
interface PrincipalResponse {
  exists: boolean;
  displayName: string | null;
  timezone: string | null;
  email: string | null;
  preferredName: string | null;
  title: string | null;
}

/** Every choice from steps 1–5 must have reached the backend — the part #2146's workaround lost. */
async function verifySavedState(baseUrl: string, secret: string, curia: CuriaProcess): Promise<string[]> {
  const get = async <T>(route: string): Promise<T> => {
    const res = await fetch(`${baseUrl}${route}`, { headers: { 'x-web-bootstrap-secret': secret } });
    if (!res.ok) throw new Error(`GET ${route} returned ${res.status}`);
    return await res.json() as T;
  };
  const [identity, status, principal] = await Promise.all([
    get<IdentityResponse>('/api/identity'),
    get<StatusResponse>('/api/setup/status'),
    get<PrincipalResponse>('/api/setup/principal'),
  ]);
  const problems: string[] = [];
  const expect = (label: string, actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  expect('principal exists', principal.exists, true);
  expect('principal name', principal.displayName, INPUT.principalName);
  expect('principal timezone', principal.timezone, INPUT.timezone);
  expect('principal email', principal.email, INPUT.email);
  expect('principal preferred name', principal.preferredName, INPUT.preferredName);
  expect('principal title', principal.title, INPUT.principalTitle);
  expect('identity configured', identity.configured, true);
  expect('assistant name', identity.identity.assistant.name, INPUT.assistantName);
  expect('assistant title', identity.identity.assistant.title, INPUT.assistantTitle);
  expect('tone', [...identity.identity.tone.baseline].sort(), [...INPUT.expectedTone].sort());
  expect('posture', identity.identity.decisionStyle.externalActions, INPUT.posture.value);
  expect('status: principal exists', status.principalExists, true);
  expect('status: identity configured', status.identityConfigured, true);
  expect('status: left setup mode', status.externalAdaptersPending, false);
  // A fresh install boots in setup mode, so finishing the wizard must cost exactly one restart.
  expect('restarts', curia.restarts, 1);
  return problems;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) {
    err('setup-wizard e2e: DATABASE_URL is not set — it names the Postgres server the throwaway database is created on');
    return 1;
  }
  if (!isLocalDatabase(sourceUrl) && !args.allowRemoteDb) {
    err('setup-wizard e2e: DATABASE_URL is not on this machine; pass --allow-remote-db to create the throwaway database there anyway');
    return 1;
  }

  const secrets: Secrets = {
    encryptionKey: randomBytes(32).toString('base64'),
    bootstrapSecret: randomBytes(32).toString('hex'),
    apiToken: randomBytes(32).toString('hex'),
  };
  const baseUrl = `http://localhost:${args.port}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(tmpdir(), `curia-setup-wizard-${stamp}.log`);

  let db: Awaited<ReturnType<typeof createEmptyDatabase>> | null = null;
  let curia: CuriaProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;

  // One cleanup, shared: a signal closes the browser, which rejects the walkthrough's
  // pending await and sends main() into its own finally. Both must wait on the same
  // run, or main() exits while the signal path is still dropping the database.
  let cleaning: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleaning ??= (async () => {
      // stop() first: it marks Curia as stopping synchronously, so a Curia that exits
      // on the terminal's Ctrl-C (it shares our process group) isn't "restarted".
      const stopped = curia?.stop();
      await browser?.close().catch(() => undefined);
      await stopped;
      if (db && !args.keepDb) await db.drop();
    })();
    return cleaning;
  };
  let interrupted = false;
  // Stays registered for the whole run (not once): tsx exits the moment a signal
  // finds no listener, so a second Ctrl-C would otherwise cut the cleanup short.
  const onSignal = (): void => {
    if (interrupted) {
      err('setup-wizard e2e: still cleaning up');
      return;
    }
    interrupted = true;
    err('\nsetup-wizard e2e: interrupted — cleaning up');
    void cleanup()
      .catch((e: unknown) => err(`setup-wizard e2e: cleanup failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (!args.skipBuild) {
      out('Building the console…');
      execFileSync('pnpm', ['build:console'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    const swept = await sweepStaleDatabases(sourceUrl);
    if (swept.length > 0) out(`Dropped ${swept.length} database(s) left by earlier runs: ${swept.join(', ')}`);
    db = await createEmptyDatabase(sourceUrl);
    out(`Database: ${db.name} (empty${args.keepDb ? ', kept afterwards' : ', dropped afterwards'})`);
    await prepareDatabase(db.url, secrets);
    out('Migrated and seeded the vault');

    curia = new CuriaProcess({
      ...process.env,
      DATABASE_URL: db.url,
      HTTP_PORT: String(args.port),
      SECRET_ENCRYPTION_KEY: secrets.encryptionKey,
      // A .env APP_ORIGIN of https://… would make the session cookie Secure, which
      // plain-http localhost never sends back.
      APP_ORIGIN: baseUrl,
    }, logPath);
    curia.start();
    out(`Booting Curia on ${baseUrl} (log: ${logPath})`);
    await waitForSetupApi(baseUrl, secrets.bootstrapSecret, curia);

    browser = await chromium.launch({
      headless: !args.headed,
      executablePath: args.chromium,
      // Playwright's own handlers kill the browser and exit(130) on a signal, cutting
      // our cleanup short; the shared cleanup closes the browser itself.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    page = await browser.newPage();
    out('Walking through the wizard:');
    await walkThroughWizard(page, baseUrl, secrets.bootstrapSecret, curia);

    const problems = await verifySavedState(baseUrl, secrets.bootstrapSecret, curia);
    if (problems.length > 0) {
      err('\nThe wizard finished but saved the wrong state:');
      for (const p of problems) err(`  ✗ ${p}`);
      err(`Server log: ${logPath}`);
      return 1;
    }
    out('  ✓ saved state matches every step, and Curia left setup mode');
    out('\nSetup wizard walkthrough passed');
    return 0;
  } catch (e) {
    // The error is the interrupt tearing the browser down, not a wizard failure.
    if (interrupted) return 130;
    err(`\nSetup wizard walkthrough FAILED: ${e instanceof Error ? e.message : String(e)}`);
    if (page) {
      mkdirSync(RESULTS_DIR, { recursive: true });
      const shot = path.join(RESULTS_DIR, `failure-${stamp}.png`);
      const saved = await page.screenshot({ path: shot, fullPage: true }).then(() => true, () => false);
      if (saved) err(`Screenshot: ${shot}`);
      err(`Page URL: ${page.url()}`);
    }
    err(`Server log: ${logPath}`);
    return 1;
  } finally {
    await cleanup();
  }
}

main().then(
  code => process.exit(code),
  (e: unknown) => {
    err(`setup-wizard e2e: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  },
);
