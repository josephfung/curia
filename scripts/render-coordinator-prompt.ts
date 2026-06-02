// scripts/render-coordinator-prompt.ts
// Renders the Coordinator system prompt to stdout by resolving all runtime
// injection blocks against a live database. Output is a plain text file
// suitable for use as promptfoo's system prompt target.
//
// Usage:
//   pnpm render-coordinator-prompt > tests/redteam/coordinator-system-prompt.txt
//   (expands to: tsx --env-file=.env scripts/render-coordinator-prompt.ts)
//
// The output file is gitignored — it may contain production identity details,
// security directives, and internal routing instructions.
//
// Re-run when any of the following change:
//   - agents/coordinator.yaml system_prompt
//   - Office identity (wizard / PUT /api/identity)
//   - config/executive-profile.yaml or executive profile via API
//   - security.trust_thresholds in config/default.yaml
//   - Specialist agents (agents/*.yaml)
//
// Requires: DATABASE_URL in .env pointing at a bootstrapped Curia instance.

import { resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { loadAllAgentConfigs, interpolateRuntimeContext } from '../src/agents/loader.js';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import { OfficeIdentityService } from '../src/identity/service.js';
import { ExecutiveProfileService, compileWritingVoiceBlock } from '../src/executive/service.js';
import { compileSecurityContextBlock } from '../src/security/security-context.js';
import { EventBus } from '../src/bus/bus.js';
import { createSilentLogger } from '../src/logger.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const AGENTS_DIR = resolve(REPO_ROOT, 'agents');
const CONFIG_DIR = resolve(REPO_ROOT, 'config');

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Add it to .env or set it in the environment.');
  }

  const logger = createSilentLogger();
  // No-op bus — this script only reads; services only use the bus for write paths.
  const bus = new EventBus(logger);
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: databaseUrl });

  let identityService: OfficeIdentityService | null = null;
  let profileService: ExecutiveProfileService | null = null;

  try {
    // ── Identity block ─────────────────────────────────────────────────────────
    identityService = new OfficeIdentityService(pool, logger, bus);
    await identityService.initialize();

    // ── Executive voice block ──────────────────────────────────────────────────
    profileService = new ExecutiveProfileService(
      pool,
      logger,
      bus,
      resolve(CONFIG_DIR, 'executive-profile.yaml'),
    );
    await profileService.initialize();

    let executiveDisplayName = 'the executive';
    if (config.ceoPrimaryEmail) {
      const nameResult = await pool.query<{ display_name: string }>(
        `SELECT c.display_name
         FROM contacts c
         JOIN contact_channel_identities ci ON ci.contact_id = c.id
         WHERE ci.channel = 'email' AND ci.channel_identifier = $1`,
        [config.ceoPrimaryEmail],
      );
      if (nameResult.rows[0]?.display_name) {
        executiveDisplayName = nameResult.rows[0].display_name;
      }
    }

    // ── Agent contact ID ───────────────────────────────────────────────────────
    const agentResult = await pool.query<{ id: string }>(
      `SELECT id FROM contacts WHERE system_role = 'agent' ORDER BY id ASC LIMIT 1`,
    );
    const agentContactId = agentResult.rows[0]?.id ?? '';
    if (!agentContactId) {
      process.stderr.write(
        'Warning: no agent contact found (system_role=agent). ' +
        'Has Curia been started at least once?\n' +
        '         agent_contact_id will be empty in the rendered prompt.\n',
      );
    }

    // ── Available specialists ──────────────────────────────────────────────────
    // Mirror the two-pass registration in index.ts.
    const agentConfigs = loadAllAgentConfigs(AGENTS_DIR);
    const registry = new AgentRegistry();
    for (const cfg of agentConfigs) {
      if (cfg.role !== 'coordinator') {
        registry.register(cfg.name, {
          role: cfg.role ?? 'specialist',
          description: cfg.description ?? cfg.name,
        });
      }
    }

    // ── Security context block ─────────────────────────────────────────────────
    const rawThresholds = config.security?.trust_thresholds;
    const thresholds = {
      information_query: rawThresholds?.information_query ?? 0.30,
      scheduling:        rawThresholds?.scheduling        ?? 0.50,
      data_export:       rawThresholds?.data_export       ?? 0.60,
      financial:         rawThresholds?.financial         ?? 0.70,
    };
    const securityContextBlock = compileSecurityContextBlock(thresholds);

    // ── Resolve the coordinator system prompt template ─────────────────────────
    const coordinatorConfig = agentConfigs.find(cfg => cfg.role === 'coordinator');
    if (!coordinatorConfig) {
      throw new Error('No coordinator agent found in agents/ directory.');
    }

    // interpolateRuntimeContext handles: ${office_identity_block},
    // ${executive_voice_block}, ${available_specialists}, ${agent_contact_id},
    // ${principal_contact_id}. The security_context_block is compiled separately.
    let systemPrompt = interpolateRuntimeContext(coordinatorConfig.system_prompt, {
      officeIdentityBlock:   identityService.compileSystemPromptBlock(),
      executiveVoiceBlock:   compileWritingVoiceBlock(profileService.get(), executiveDisplayName),
      availableSpecialists:  registry.specialistSummary(),
      agentContactId,
    });

    // ${security_context_block} is not handled by interpolateRuntimeContext
    // (it's injected by the security layer, not the runtime context path).
    systemPrompt = systemPrompt.replace('${security_context_block}', securityContextBlock);

    // ── Prepend representative per-turn injected blocks ────────────────────────
    // These blocks are injected fresh on every message turn by the runtime.
    // Including representative values here ensures the red team probes the full
    // effective prompt surface, including the identity and contact detail sections
    // that an adversary would see on a live instance.
    const today = new Date().toISOString().split('T')[0]!;
    const ceoPrimaryEmail = config.ceoPrimaryEmail ?? 'ceo@example.com';
    const perTurnBlocks = [
      `## Current Date & Time`,
      `Today is ${today}. Timezone: America/Toronto (EDT, UTC-4).`,
      ``,
      `## Principal Contact Details`,
      `The CEO's verified contact details:`,
      `- Email: ${ceoPrimaryEmail}`,
      `- Signal: +1 555-000-0001`,
      ``,
      `## Your Contact Details`,
      `Your own verified contact details:`,
      `- Email: curia-agent@example.com`,
      `- Contact ID: ${agentContactId || '<agent-contact-id>'}`,
      ``,
    ].join('\n');

    process.stdout.write(perTurnBlocks + '\n' + systemPrompt + '\n');
  } finally {
    await identityService?.stop();
    await profileService?.stop();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`render-coordinator-prompt: fatal error\n${String(err)}\n`);
  process.exit(1);
});
