// scripts/inspect-prompts.ts
// Prints the resolved system prompt injection blocks as JSON to stdout.
//
// Usage:
//   pnpm inspect-prompts
//   (expands to: tsx --env-file=.env scripts/inspect-prompts.ts)
//
// On the server: pnpm --prefix /opt/curia tsx --env-file=.env scripts/inspect-prompts.ts
//
// Pipe the output into curia-deploy to update the eval harness mock blocks:
//   pnpm inspect-prompts > /path/to/curia-deploy/tests/eval/prompt-blocks.json
//
// When to re-run:
//   - After editing config/office-identity.yaml or applying identity changes via the API
//   - After editing config/executive-profile.yaml or applying profile changes via the API
//   - After changing security.trust_thresholds in config/default.yaml
//   - After adding or removing specialist agents (agents/*.yaml)
//
// This script connects to the database directly — it does NOT require Curia to be running.
// It initializes only the services it needs, so it is safe to run alongside a live instance.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { loadAllAgentConfigs } from '../src/agents/loader.js';
import { AgentRegistry } from '../src/agents/agent-registry.js';
import { OfficeIdentityService } from '../src/identity/service.js';
import { ExecutiveProfileService, compileWritingVoiceBlock } from '../src/executive/service.js';
import { compileSecurityContextBlock } from '../src/security/security-context.js';
import { EventBus } from '../src/bus/bus.js';
import { createSilentLogger } from '../src/logger.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = resolve(REPO_ROOT, 'agents');
const CONFIG_DIR = resolve(REPO_ROOT, 'config');

async function main(): Promise<void> {
  const logger = createSilentLogger();
  // No-op bus — this script only reads; the services use the bus only when writing
  // (update/reload paths), which never happen here.
  const bus = new EventBus(logger);

  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // ── Identity block ─────────────────────────────────────────────────────────
    const identityService = new OfficeIdentityService(
      pool,
      logger,
      bus,
      resolve(CONFIG_DIR, 'office-identity.yaml'),
    );
    await identityService.initialize();

    // ── Executive voice block ──────────────────────────────────────────────────
    const profileService = new ExecutiveProfileService(
      pool,
      logger,
      bus,
      resolve(CONFIG_DIR, 'executive-profile.yaml'),
    );
    await profileService.initialize();

    // Look up the CEO's display name the same way index.ts does.
    // Falls back to 'the executive' if CEO_PRIMARY_EMAIL is unset or the contact
    // doesn't exist yet (first-run case before ceo-bootstrap has run).
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
    // Read the existing agent contact — do NOT call bootstrapAgentIdentity here,
    // as that would create the record if absent and produce unwanted side effects
    // in a read-only inspection script.
    const agentResult = await pool.query<{ id: string }>(
      `SELECT id FROM contacts WHERE system_role = 'agent' LIMIT 1`,
    );
    const agentContactId = agentResult.rows[0]?.id ?? '';
    if (!agentContactId) {
      // Non-fatal: Curia may not have been bootstrapped yet. The eval harness
      // doesn't use ${agent_contact_id} for routing tests; leave it empty.
      process.stderr.write(
        'Warning: no agent contact found (system_role=agent). Has Curia been started at least once?\n' +
        '         ${agent_contact_id} will be empty in the output.\n',
      );
    }

    // ── Available specialists ──────────────────────────────────────────────────
    // Mirror the two-pass registration in index.ts: load all agent configs, then
    // register non-coordinator agents so specialistSummary() produces the correct
    // @name: description lines.
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
    // Read from config the same way index.ts does. The defaults here match
    // Curia's hardcoded fallbacks so the output is correct even without a
    // config/default.yaml override.
    const rawThresholds = config.security?.trust_thresholds;
    const thresholds = {
      information_query: rawThresholds?.information_query ?? 0.30,
      scheduling:        rawThresholds?.scheduling        ?? 0.50,
      data_export:       rawThresholds?.data_export       ?? 0.60,
      financial:         rawThresholds?.financial         ?? 0.70,
    };
    const securityContextBlock = compileSecurityContextBlock(thresholds);

    // ── Output ─────────────────────────────────────────────────────────────────
    const output = {
      _note: [
        'Generated by: pnpm inspect-prompts (scripts/inspect-prompts.ts).',
        'Re-run after changing: office-identity.yaml, executive-profile.yaml,',
        'security trust_thresholds, or agents/*.yaml.',
        'Paste into: tests/eval/prompt-blocks.json in curia-deploy.',
      ].join(' '),
      coordinator: {
        office_identity_block:   identityService.compileSystemPromptBlock(),
        security_context_block:  securityContextBlock,
        executive_voice_block:   compileWritingVoiceBlock(profileService.get(), executiveDisplayName),
        agent_contact_id:        agentContactId,
        available_specialists:   registry.specialistSummary(),
      },
    };

    // Write to stdout — caller can pipe to a file.
    // Use process.stdout.write to avoid the trailing newline console.log adds,
    // which can confuse downstream JSON parsers when appended to.
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`inspect-prompts: fatal error\n${String(err)}\n`);
  process.exit(1);
});
