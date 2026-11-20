// tests/setup-wizard/cli.ts — drive the /setup page end to end in a real browser (#2146, #2358).
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
//   3. Signs in with the bootstrap secret and walks the Setup page's eight steps with Save
//      and continue, asserting each step's URL, "Step N of 8" label and heading: Who it's
//      for (someone else, with the operator's details), Curia's name, the channel steps
//      (the app for messaging and voice), Apply & restart.
//   4. Plays supervisor: Apply & restart (`/api/system/restart`) ends the process cleanly
//      (Docker's restart policy brings it back in production), so the script restarts it
//      once, then waits for the page to say every step was checked again.
//   5. Checks Start onboarding is locked (the channel steps can't pass on a plain-http test
//      install with no keys).
//   6. Opens the optional extras from the step list and walks them: a tone and an
//      independence level, Google Workspace's keys, a Tavily key, and Capabilities (Meeting
//      debriefs off; Meetings and Email triage locked). The last extra's Save and continue
//      returns to Start onboarding. Then reads the saved state back over the API.
//
// Exits 1 on any failure, leaving a screenshot and the server log path in the output.
// The database is dropped afterwards (Ctrl-C included) unless --keep-db; one left by a
// run that was killed outright is swept by the next run.
//
// The npm script launches this with `node --import tsx`, not the `tsx` CLI: the CLI's
// parent process relays Ctrl-C and SIGKILLs a child that is still cleaning up ~30ms
// later, which would leave the database behind.
//
// The placeholder Anthropic key means Curia's name suggestion fails. That is expected:
// the page must cope with it and keep the default name.
//
// Run before every release cut (CLAUDE.md pre-flight C) and whenever the Setup page, the
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
import { databaseName, isLocalDatabase, likePrefix } from '../shared/database-url.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'src', 'db', 'migrations');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/** Must match the wizard: a run that sees a different count is testing a different wizard. */
const EXPECTED_TOTAL_STEPS = 8;
/** First boot runs every migration; generous so a slow laptop isn't a false failure. */
const BOOT_TIMEOUT_MS = 180_000;
/** Covers the restart: process exit, re-boot, then the wizard's 2s status poll. */
const FINISH_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 15_000;
/** The wizard needs one; a process that keeps exiting 0 is a boot loop, not a restart. */
const MAX_RESTARTS = 3;

/** What the walkthrough enters. Every value differs from the wizard's defaults so a dropped field shows. */
const INPUT = {
  operatorName: 'Walkthrough Operator',
  operatorEmail: 'operator@example.com',
  principalName: 'Wizard Walkthrough Principal',
  principalTitle: 'Chief Testing Officer',
  email: 'walkthrough@example.com',
  timezone: 'Europe/Lisbon',
  pronouns: 'they/them',
  assistantName: 'Robin Curia',
  assistantTitle: 'Walkthrough EA',
  // Channel steps (#2358, PR 3b): fake keys. They are saved and the channels turned on;
  // nothing here talks to Telnyx, Deepgram or Cartesia before the restart.
  nylasKey: 'nyk_v0_walkthrough_placeholder',
  telnyxKey: 'KEY_walkthrough_placeholder',
  telnyxNumber: '+14165550188',
  telnyxWebhookKey: 'walkthrough-webhook-public-key',
  principalMobile: '+14165550100',
  deepgramKey: 'walkthrough-deepgram',
  cartesiaKey: 'walkthrough-cartesia',
  cartesiaVoice: 'walkthrough-voice-id',
  // Optional extras (#2358, PR 3c). Nothing signs in to Google or searches with these.
  curiaGoogleEmail: 'curia-walkthrough@example.com',
  googleClientId: 'walkthrough.apps.googleusercontent.com',
  googleClientSecret: 'walkthrough-google-secret',
  tavilyKey: 'tvly-walkthrough-placeholder',
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

async function expectStep(page: Page, step: number, id: string, heading: string): Promise<void> {
  try {
    // The page opens a returning operator on the first unfinished step with no ?step, so
    // the first step is matched by its heading alone.
    await page.waitForURL(url => url.pathname === '/setup' && (step === 1 || url.searchParams.get('step') === id), { timeout: STEP_TIMEOUT_MS });
    await page.getByText(new RegExp(`^Step ${step} of ${EXPECTED_TOTAL_STEPS}`)).waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.getByRole('heading', { name: heading }).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (e) {
    const firstLine = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    throw new Error(`did not reach step ${step} ("${heading}") — still on ${new URL(page.url()).search || page.url()}. ${firstLine}`);
  }
  out(`  ✓ step ${step}: ${heading}`);
}

/**
 * Fills fields by their labels and leaves the last one: a field saves when the operator
 * leaves it (there is no Save button), then waits for the group's message.
 */
async function fillForm(page: Page, values: Record<string, string>, expected: string | null): Promise<void> {
  const entries = Object.entries(values);
  for (const [label, value] of entries) await page.getByLabel(label, { exact: false }).fill(value);
  await page.getByLabel(entries.at(-1)![0], { exact: false }).blur();
  if (expected) await page.getByText(expected).waitFor({ timeout: STEP_TIMEOUT_MS });
}

async function saveAndContinue(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Save and continue|Continue)$/ }).click();
}

async function walkThroughSetup(page: Page, baseUrl: string, secret: string, curia: CuriaProcess): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await page.getByPlaceholder('Access key').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // A new install is in Setup, so the router sends the operator to the Setup page.
  await expectStep(page, 1, 'who', 'Who are you setting Curia up for?');
  // A first run: the setup guide opens by itself (nothing is sent to it: the model key is fake).
  const guide = page.getByRole('complementary', { name: 'Setup guide' });
  await guide.waitFor({ timeout: STEP_TIMEOUT_MS });
  await guide.getByRole('button', { name: 'Close setup guide' }).click();
  await guide.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  out('  ✓ the setup guide opened by itself on a first run, and closes');
  await page.getByRole('radio', { name: /Someone else/ }).click();
  await page.getByLabel('Your name').fill(INPUT.operatorName);
  await page.getByLabel('Your email').fill(INPUT.operatorEmail);
  await page.locator('#setup-principal-name').fill(INPUT.principalName);
  await page.getByLabel(/^Title/).fill(INPUT.principalTitle);
  await page.locator('#setup-principal-email').fill(INPUT.email);
  await page.getByLabel('Timezone').selectOption(INPUT.timezone);
  await page.getByLabel(/^Pronouns/).fill(INPUT.pronouns);
  await saveAndContinue(page);

  await expectStep(page, 2, 'curia_name', 'What should Curia be called?');
  // The name loads after a suggestion attempt (which fails here: the Anthropic key is fake).
  await page.locator('#setup-curia-name:not([disabled])').waitFor({ timeout: STEP_TIMEOUT_MS });
  // "Need help?" opens the guide with the step named in its composer.
  await page.getByRole('button', { name: 'Need help? Ask the setup guide' }).click();
  const composer = guide.getByRole('textbox', { name: 'Message' });
  await composer.waitFor({ timeout: STEP_TIMEOUT_MS });
  try {
    await page.waitForFunction(
      (want) => document.querySelector<HTMLTextAreaElement>('aside[aria-label="Setup guide"] textarea')?.value === want,
      'I’m on the Curia’s name step. ',
      { timeout: STEP_TIMEOUT_MS },
    );
  } catch {
    throw new Error(`the guide's composer holds "${await composer.inputValue()}", not the step`);
  }
  await guide.getByRole('button', { name: 'Close setup guide' }).click();
  out('  ✓ Need help? opened the guide with the step in its composer');
  await page.locator('#setup-curia-name').fill(INPUT.assistantName);
  await page.getByLabel('Title').fill(INPUT.assistantTitle);
  await saveAndContinue(page);

  await expectStep(page, 3, 'email', 'Curia’s own email');
  await fillForm(page, { 'Nylas API key': INPUT.nylasKey }, 'Saved. Now connect Curia’s mailbox below.');
  await saveAndContinue(page);

  // The principal's first name names the later steps.
  await expectStep(page, 4, 'messaging', 'How should Curia message Wizard?');
  await page.getByRole('radio', { name: /Text message/ }).click();
  await page.getByRole('radio', { name: /Text message/, checked: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
  await fillForm(page, {
    'Telnyx API key': INPUT.telnyxKey,
    'Curia’s number': INPUT.telnyxNumber,
    'Telnyx webhook public key': INPUT.telnyxWebhookKey,
  }, 'Saved and turned on. It starts when you apply and restart.');
  // Typed the way people write it; stored as E.164, which the channels compare exactly.
  await fillForm(page, { 'Wizard’s mobile number': '+1 (416) 555-0100' }, null);
  await page.getByText(`Saved: ${INPUT.principalMobile}`).waitFor({ timeout: STEP_TIMEOUT_MS });
  out('  ✓ text message keys saved, the channel turned on, the principal’s mobile linked');
  await saveAndContinue(page);

  await expectStep(page, 5, 'voice', 'How will Wizard talk to Curia?');
  // Text messages can't carry calls, so voice followed messaging to the app.
  await page.getByRole('radio', { name: /In the Curia app/, checked: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
  // Saved, but not turned on: LiveKit's keys aren't seeded on this install (#2689).
  await fillForm(page, {
    'Deepgram API key': INPUT.deepgramKey,
    'Cartesia API key': INPUT.cartesiaKey,
    'Curia’s voice': INPUT.cartesiaVoice,
  }, 'Saved. Voice also needs LiveKit’s keys, which come with Curia’s install; this install doesn’t have them yet.');
  await saveAndContinue(page);

  await expectStep(page, 6, 'mailbox_signin', 'Wizard’s email and calendar');
  await saveAndContinue(page);

  await expectStep(page, 7, 'apply', 'Apply and restart');
  await page.getByRole('button', { name: 'Apply and restart' }).click();
  out('  ✓ pressed Apply and restart; waiting for Curia to come back');
  const deadline = Date.now() + FINISH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (curia.crashed) throw new Error(`${curia.crashed} after Apply and restart`);
    if (await page.getByText('Restarted. Every step was checked again.').isVisible()) break;
    const failure = await page.locator('.setup-status.attention[role="alert"]').textContent({ timeout: 1 }).catch(() => null);
    if (failure) throw new Error(`Apply and restart failed: ${failure}`);
    await page.waitForTimeout(500);
  }
  if (!(await page.getByText('Restarted. Every step was checked again.').isVisible())) {
    throw new Error(`Curia did not come back within ${FINISH_TIMEOUT_MS / 1000}s`);
  }
  out('  ✓ restarted and re-checked');
  await saveAndContinue(page);

  await expectStep(page, 8, 'start', 'Start onboarding');
  // Email, messaging over https and voice can't pass on a plain-http test install with no
  // keys, so Start onboarding stays locked and says what's left.
  if (await page.getByRole('button', { name: 'Start onboarding', exact: true }).isEnabled()) {
    throw new Error('Start onboarding is enabled although required steps are not done');
  }
  await page.getByText(/^Finish .* first\.$/).waitFor({ timeout: STEP_TIMEOUT_MS });
  out('  ✓ Start onboarding is locked and lists what’s left');

  // The optional extras: opened from the step list, never numbered.
  await page.getByRole('navigation', { name: 'Setup steps' }).getByRole('button', { name: 'Working style' }).click();
  await expectExtra(page, 'working_style', 'Working style');
  // Each choice saves when picked; Save and continue waits for both saves to land.
  await page.getByRole('radio', { name: /Crisp & direct/ }).click();
  await page.getByRole('radio', { name: /Crisp & direct/, checked: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
  await page.getByRole('radio', { name: /Spot-check/ }).click();
  await page.getByRole('radio', { name: /Spot-check/, checked: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
  await saveAndContinue(page);

  await expectExtra(page, 'google_workspace', 'Google Workspace');
  await fillForm(page, {
    'Curia’s Google address': INPUT.curiaGoogleEmail,
    'OAuth client ID': INPUT.googleClientId,
    'OAuth client secret': INPUT.googleClientSecret,
  }, 'Saved.');
  await saveAndContinue(page);

  await expectExtra(page, 'web_research', 'Higher web search limit');
  await fillForm(page, { 'Tavily API key': INPUT.tavilyKey }, 'Saved.');
  await saveAndContinue(page);

  await expectExtra(page, 'capabilities', 'Capabilities');
  // Meetings is always on; email triage is left for the principal, so it is locked in Setup.
  for (const locked of ['Meetings', 'Email triage']) {
    if (await page.getByRole('checkbox', { name: locked }).isEnabled()) throw new Error(`${locked} can be switched in Setup`);
  }
  await page.getByRole('checkbox', { name: 'Meeting debriefs', checked: true }).click();
  await page.getByText('Meeting debriefs off. It applies when you apply and restart.').waitFor({ timeout: STEP_TIMEOUT_MS });
  await saveAndContinue(page);
  await expectStep(page, 8, 'start', 'Start onboarding');
  out('  ✓ optional extras saved; the last returned to Start onboarding');
}

async function expectExtra(page: Page, id: string, heading: string): Promise<void> {
  try {
    await page.waitForURL(url => url.pathname === '/setup' && url.searchParams.get('step') === id, { timeout: STEP_TIMEOUT_MS });
    await page.getByText(/^Optional extra$/).waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.getByRole('heading', { name: heading }).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (e) {
    const firstLine = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    throw new Error(`did not reach the "${heading}" extra — still on ${new URL(page.url()).search || page.url()}. ${firstLine}`);
  }
  out(`  ✓ extra: ${heading}`);
}

interface IdentityResponse {
  configured: boolean;
  inSetup?: boolean;
  identity: { assistant: { name: string; title: string }; tone: { style: string } };
}
interface StatusResponse {
  principalExists: boolean;
  identityConfigured: boolean;
  externalAdaptersPending: boolean;
  inSetup: boolean;
  setup: { setupFor: string | null; operatorName: string | null; operatorEmail: string | null; messagingRoute: string | null; voiceRoute: string | null };
}
interface PrincipalResponse {
  exists: boolean;
  contactId: string | null;
  displayName: string | null;
  timezone: string | null;
  email: string | null;
  title: string | null;
  pronouns: string | null;
}
interface ChecklistResponse {
  setupComplete: boolean;
  tasks: Array<{ id: string; status: string }>;
}

/** Every choice made on the Setup page must have reached the backend (#2146, #2358). */
async function verifySavedState(baseUrl: string, secret: string, curia: CuriaProcess): Promise<string[]> {
  const get = async <T>(route: string): Promise<T> => {
    const res = await fetch(`${baseUrl}${route}`, { headers: { 'x-web-bootstrap-secret': secret } });
    if (!res.ok) throw new Error(`GET ${route} returned ${res.status}`);
    return await res.json() as T;
  };
  const [identity, status, principal, checklist, channels, vault, autonomy, agents] = await Promise.all([
    get<IdentityResponse>('/api/identity'),
    get<StatusResponse>('/api/setup/status'),
    get<PrincipalResponse>('/api/setup/principal'),
    get<ChecklistResponse>('/api/setup/checklist'),
    get<{ channels: Array<{ name: string; state: string }> }>('/api/registry/channels'),
    get<{ configured_keys: string[] }>('/api/vault/status'),
    get<{ autonomy: { score: number } | null }>('/api/autonomy'),
    get<{ agents: Array<{ name: string; state: string }> }>('/api/registry/agents'),
  ]);
  const problems: string[] = [];
  const expect = (label: string, actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  expect('setup for', status.setup.setupFor, 'other');
  expect('operator name', status.setup.operatorName, INPUT.operatorName);
  expect('operator email', status.setup.operatorEmail, INPUT.operatorEmail);
  expect('messaging route', status.setup.messagingRoute, 'sms');
  expect('voice route', status.setup.voiceRoute, 'app');
  expect('principal exists', principal.exists, true);
  expect('principal name', principal.displayName, INPUT.principalName);
  expect('principal title', principal.title, INPUT.principalTitle);
  expect('principal email', principal.email, INPUT.email);
  expect('principal timezone', principal.timezone, INPUT.timezone);
  expect('principal pronouns', principal.pronouns, INPUT.pronouns);
  expect('identity configured', identity.configured, true);
  expect('assistant name', identity.identity.assistant.name, INPUT.assistantName);
  expect('assistant title', identity.identity.assistant.title, INPUT.assistantTitle);
  // Still in Setup: Start onboarding is locked until the channel steps pass.
  expect('still in Setup', identity.inSetup, true);
  expect('status: still in Setup', status.inSetup, true);
  const done = (id: string) => checklist.tasks.find((t) => t.id === id)?.status;
  expect('checklist: who it\'s for', done('who'), 'done');
  expect('checklist: Curia\'s name', done('curia_name'), 'done');
  expect('checklist: setup complete', checklist.setupComplete, false);
  // The channel steps' forms (#2358, PR 3b).
  const state = (name: string) => channels.channels.find((c) => c.name === name)?.state;
  expect('sms channel', state('sms'), 'enabled');
  expect('voice channel (no LiveKit keys yet, #2689)', state('voice') === 'enabled', false);
  for (const key of ['channel.email.nylas_api_key', 'channel.sms.api_key', 'channel.sms.from_number', 'channel.sms.webhook_public_key',
    'channel.voice.deepgram_api_key', 'channel.voice.cartesia_api_key', 'channel.voice.cartesia_voice_id']) {
    expect(`vault: ${key}`, vault.configured_keys.includes(key), true);
  }
  // The optional extras (#2358, PR 3c): Crisp & direct is a template, Spot-check is 85.
  expect('tone: Crisp & direct', identity.identity.tone.style.startsWith('Crisp and direct.'), true);
  expect('independence: Spot-check', autonomy.autonomy?.score, 85);
  for (const key of ['curia_google_email', 'google_oauth_client_id', 'google_oauth_client_secret', 'tavily_api_key']) {
    expect(`vault: ${key}`, vault.configured_keys.includes(key), true);
  }
  expect('checklist: Google Workspace', done('google_workspace'), 'done');
  // Capabilities: Meeting debriefs switched off (its agent), the rest left alone.
  const agentState = (name: string) => agents.agents.find((a) => a.name === name)?.state;
  expect('capability: Meeting debriefs off', agentState('meeting-debrief'), 'installed');
  expect('capability: Web research left on', agentState('research-analyst'), 'enabled');
  if (principal.contactId) {
    const ids = await get<{ identities: Array<{ channel: string; channelIdentifier: string }> }>(`/api/contacts/${principal.contactId}/identities`);
    expect('principal mobile linked as E.164', ids.identities.some((i) => i.channel === 'sms' && i.channelIdentifier === INPUT.principalMobile), true);
  } else {
    problems.push('principal contact id: missing');
  }
  expect('status: left setup-required mode', status.externalAdaptersPending, false);
  // A fresh install boots in setup-required mode; Apply and restart costs exactly one restart.
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
    out('Walking through the Setup page:');
    await walkThroughSetup(page, baseUrl, secrets.bootstrapSecret, curia);

    const problems = await verifySavedState(baseUrl, secrets.bootstrapSecret, curia);
    if (problems.length > 0) {
      err('\nThe Setup page finished but saved the wrong state:');
      for (const p of problems) err(`  ✗ ${p}`);
      err(`Server log: ${logPath}`);
      return 1;
    }
    out('  ✓ saved state matches every step, and Curia left setup-required mode');
    out('\nSetup page walkthrough passed');
    return 0;
  } catch (e) {
    // The error is the interrupt tearing the browser down, not a wizard failure.
    if (interrupted) return 130;
    err(`\nSetup page walkthrough FAILED: ${e instanceof Error ? e.message : String(e)}`);
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
