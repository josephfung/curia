// tests/scenarios/ci-setup.ts — readies a fresh, migrated database for the weekly behavior
// gate (.github/workflows/behavior-gate.yml). Run after migrations and the vault seed:
//
//   pnpm exec tsx tests/scenarios/ci-setup.ts
//
// It does what a maintainer's scenario database already has:
//   1. the scenario principal, Avery Testwell, with their verified email and Signal identity
//      (principal-fixture.ts), which an unfiltered gate run refuses to start without;
//   2. the opt-in agents, bundles and tools a real install enables by hand
//      (config/registry-defaults.yaml leaves them out): the calendar and ceo-inbox agents,
//      the ceo-inbox and learning bundles, and their tools. The gate's inbox and calendar
//      cases need them loaded; a fresh database would boot without them.
//
// It refuses a database that already has a principal: renaming one is for a disposable copy,
// by hand (tests/scenarios/README.md, "The scenario principal"), never a script's guess.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { ensurePrincipalContact } from '../../src/contacts/ensure-principal.js';
import { createPool } from '../../src/db/connection.js';
import { SCENARIO_PRINCIPAL, SCENARIO_PRINCIPAL_SQL } from './principal-fixture.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALLED_BY = 'behavior-gate-ci';
// Plain pino to stdout, as scripts/seed-vault.ts: createLogger writes to curia.log outside production.
const logger = pino({ name: 'scenario-ci-setup' });

/** The registry rows to enable, read from the repo so a renamed tool fails the unit test, not a Sunday run. */
export function ciRegistryRows(repoRoot: string = REPO_ROOT): { agents: string[]; skills: string[]; tools: string[] } {
  const agents = ['calendar', 'ceo-inbox'];
  const skills = ['ceo-inbox', 'learning'];
  // calendar's tools as well: reconcile holds them back without a Nylas key (#1974).
  const bundleTools = ['calendar', 'ceo-inbox', 'learning'].flatMap(bundle =>
    readdirSync(path.join(repoRoot, 'skills', bundle, 'tools'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name),
  );
  // Pinned by ceo-inbox, enabled by no bundle or default.
  const tools = [...bundleTools, 'contact-register'];
  for (const agent of agents) {
    if (!existsSync(path.join(repoRoot, 'agents', `${agent}.yaml`))) throw new Error(`ci-setup: no agents/${agent}.yaml`);
  }
  return { agents, skills, tools };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('ci-setup: DATABASE_URL is not set');
  const pool = createPool(databaseUrl, logger, { applicationName: 'scenario-ci-setup' });
  try {
    const existing = await pool.query(`SELECT 1 FROM contacts WHERE system_role = 'principal'`);
    if (existing.rowCount !== 0) {
      throw new Error('ci-setup: this database already has a principal; it is only for a fresh, migrated database');
    }
    await ensurePrincipalContact({ displayName: SCENARIO_PRINCIPAL.displayName }, pool, logger);
    // One multi-statement query runs as one implicit transaction, as psql -c does.
    await pool.query(SCENARIO_PRINCIPAL_SQL);

    const rows = ciRegistryRows();
    const columns = '(name, enabled, installed_by, enabled_at, enabled_by) SELECT unnest($1::text[]), true, $2, now(), $2';
    const upsert = 'ON CONFLICT (name) DO UPDATE SET enabled = true, enabled_at = now(), enabled_by = $2';
    await pool.query(`INSERT INTO agent_registry ${columns} ${upsert}`, [rows.agents, INSTALLED_BY]);
    await pool.query(`INSERT INTO skill_registry ${columns} ${upsert}`, [rows.skills, INSTALLED_BY]);
    await pool.query(`INSERT INTO tool_registry ${columns} ${upsert}`, [rows.tools, INSTALLED_BY]);
    logger.info(
      { principal: SCENARIO_PRINCIPAL.displayName, agents: rows.agents, skills: rows.skills, tools: rows.tools.length },
      'ci-setup: scenario principal created and opt-in registry rows enabled',
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    logger.error({ err }, 'ci-setup failed');
    process.exit(1);
  });
}
