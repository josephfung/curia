// TODO(remove-after-541): one-shot migration for the EXISTING production deployment.
// Enrolls every on-disk skill/agent as ENABLED so upgrade preserves today's behavior
// (everything that was auto-loaded stays loaded). Fresh installs do NOT run this — they
// rely on config/registry-defaults.yaml. Idempotent: re-running only adds missing rows.
// Delete this script and its package.json entry after the production backfill is done.
//
// Run: pnpm backfill:registry

import * as path from 'node:path';
import { createPool } from '../src/db/connection.js';
import { createLogger } from '../src/logger.js';
import { discoverSkillManifests } from '../src/skills/loader.js';
import { discoverAgentManifests } from '../src/agents/loader.js';
import { RegistryRepo } from '../src/registry/registry-repo.js';

async function main(): Promise<void> {
  const logger = createLogger('info');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = createPool(databaseUrl, logger);
  try {
    const skillsDir = path.resolve(import.meta.dirname, '../skills');
    const agentsDir = path.resolve(import.meta.dirname, '../agents');

    const skillRepo = new RegistryRepo(pool, 'skill_registry');
    const agentRepo = new RegistryRepo(pool, 'agent_registry');

    let skillsEnrolled = 0, skillsSkipped = 0, skillsErrored = 0;
    for (const disc of discoverSkillManifests(skillsDir)) {
      if (disc.metadata === null) {
        logger.warn({ skill: disc.name, error: disc.error }, 'skipping skill with unparseable manifest');
        skillsErrored++;
        continue;
      }
      const existing = await skillRepo.getRow(disc.name);
      if (existing?.enabled) { skillsSkipped++; continue; }
      await skillRepo.install(disc.name, 'backfill');
      await skillRepo.enable(disc.name, 'backfill');
      skillsEnrolled++;
    }

    let agentsEnrolled = 0, agentsSkipped = 0, agentsErrored = 0;
    for (const disc of discoverAgentManifests(agentsDir)) {
      if (disc.config === null) {
        logger.warn({ agent: disc.name, error: disc.error }, 'skipping agent with unparseable config');
        agentsErrored++;
        continue;
      }
      const existing = await agentRepo.getRow(disc.name);
      if (existing?.enabled) { agentsSkipped++; continue; }
      await agentRepo.install(disc.name, 'backfill');
      await agentRepo.enable(disc.name, 'backfill');
      agentsEnrolled++;
    }

    logger.info(
      { skillsEnrolled, skillsSkipped, skillsErrored, agentsEnrolled, agentsSkipped, agentsErrored },
      'registry backfill complete',
    );
    if (skillsErrored > 0 || agentsErrored > 0) {
      logger.warn({ skillsErrored, agentsErrored }, 'backfill completed with parse errors; some items were not enrolled');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console — standalone script, pino not guaranteed flushed on throw
  console.error('backfill failed:', err);
  process.exit(1);
});
