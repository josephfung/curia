// scripts/inspect-prompts.ts
// Prints, as JSON on stdout, the deployment-specific inputs agent system prompts are
// rendered from. curia-deploy's eval harness renders each agent's prompt locally from
// this snapshot with curia's own builders (curia-deploy#261), so it can score a local
// edit to an agent YAML or SKILL.md against this deployment's identity, roster,
// autonomy and contact details.
//
// Usage:
//   pnpm inspect-prompts
//   (expands to: tsx --env-file=.env scripts/inspect-prompts.ts)
//
// In production it is run inside the app container by curia-deploy's
// scripts/fetch-prompt-blocks.sh, which validates the output and adds the image's
// commit before writing tests/eval/prompt-blocks.json.
//
// The values come from the test-mode stack (createTestModeStack, llm: 'offline'),
// the same assembly path production boots through. So the specialist roster honours
// registry enablement, security.trust_thresholds are validated rather than defaulted
// (#1729), and every value is the one the coordinator's runtime config holds — the
// inputs buildBaseSystemPrompt() reads on a live turn. Nothing here re-derives them.
//
// Re-run when any of these change:
//   - Office identity (wizard / PUT /api/identity) or the autonomy score
//   - security.trust_thresholds in config/default.yaml
//   - Specialist agents (agents/*.yaml) or their registry enablement
//   - The principal's verified channel identities, or Curia's own email / Signal number
//
// Requires: DATABASE_URL pointing at a migrated Curia instance, and SECRET_ENCRYPTION_KEY.
// No LLM key is needed — providers are offline and nothing is sent. The vault key is
// required (unlike render-coordinator-prompt): without it the Signal number and the
// email grant check are missing, and the JSON would not record that it is degraded.
//
// What it writes: only the idempotent bootstrap upserts every boot already performs
// (office identity seed, agent self-contact). It does not write registry rows, and it
// is safe to run beside a live instance.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import pino from 'pino';
import { createTestModeStack, type TestModeStack } from '../src/startup/test-mode-stack.js';
import type { Logger } from '../src/logger.js';
import { discoverSkillManifests } from '../src/skills/skill-loader.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * The snapshot. snake_case because it is a JSON file read by another repo. Every field
 * is a deployment-wide input; which agent receives which block is decided at render
 * time by resolveSystemPromptSources(), not here.
 */
export interface PromptInputsSnapshot {
  _note: string;
  /** The curia the inputs were taken from. The harness warns when its checkout differs. */
  curia: { version: string };
  timezone: string;
  office_identity_block: string;
  security_context_block: string;
  available_specialists: string;
  /** null when autonomy_config has no row (pre-migration) — production omits the block too. */
  autonomy: { score: number; band: string } | null;
  agent_contact_id: string;
  principal_contact_id: string | null;
  /** Verified + active only (readPrincipalIdentitySnapshot) — the fields the block renders. */
  principal_identities: Array<{ channel: string; channel_identifier: string; label: string | null }>;
  principal_primary_email: string | null;
  channel_accounts: { email: string | null; phone: string | null };
  /**
   * SKILL.md bundles on disk that this deployment does not enable. Production never
   * registers them, so a pin on one contributes no instructions; the harness omits them
   * too. Listed as disabled rather than enabled so a skill the harness adds locally,
   * which production has never seen, is not dropped.
   */
  disabled_skills: string[];
}

/** Read every input from the coordinator's runtime config, which is what production feeds the builder. */
export async function buildPromptInputsSnapshot(
  stack: Pick<TestModeStack, 'agent' | 'principalContactId' | 'skillRegistry'>,
  curiaVersion: string,
  /** Every SKILL.md bundle discovered on disk — the stack's skills dir. */
  discoveredSkillNames: readonly string[],
): Promise<PromptInputsSnapshot> {
  const rc = stack.agent('coordinator').runtimeConfig;

  // The coordinator always receives these. A missing one means assembly changed shape,
  // and a snapshot without it would silently render a coordinator with that block gone.
  // The every-agent fields are checked for presence too: an absent principalIdentities
  // would otherwise read as `[]`, indistinguishable from a principal with no verified
  // identities, and every agent would lose ## Who you serve unnoticed.
  if (!rc.officeIdentityService) throw new Error('coordinator runtime config has no officeIdentityService');
  if (!rc.securityContextBlock) throw new Error('coordinator runtime config has no securityContextBlock');
  if (rc.availableSpecialists === undefined) throw new Error('coordinator runtime config has no availableSpecialists');
  if (!rc.autonomyService) throw new Error('coordinator runtime config has no autonomyService');
  if (!rc.principalIdentities) throw new Error('coordinator runtime config has no principalIdentities');
  if (!rc.principalPrimaryEmail) throw new Error('coordinator runtime config has no principalPrimaryEmail');
  if (!rc.channelAccounts) throw new Error('coordinator runtime config has no channelAccounts');
  if (!rc.agentContactId) throw new Error('coordinator runtime config has no agentContactId');
  const timezone = rc.timezone?.trim();
  if (!timezone) throw new Error('coordinator runtime config has no timezone (TIMEZONE)');

  const autonomy = await rc.autonomyService.getConfig();

  return {
    _note: [
      'Generated by curia scripts/inspect-prompts.ts (via curia-deploy scripts/fetch-prompt-blocks.sh).',
      'Inputs, not rendered prompts: the eval harness renders each agent with curia\'s own builders.',
      'Holds instance-specific data (contact UUIDs, addresses, identity) — keep it out of git.',
    ].join(' '),
    curia: { version: curiaVersion },
    timezone,
    office_identity_block: rc.officeIdentityService.compileSystemPromptBlock(),
    security_context_block: rc.securityContextBlock,
    available_specialists: rc.availableSpecialists,
    autonomy: autonomy ? { score: autonomy.score, band: autonomy.band } : null,
    agent_contact_id: rc.agentContactId,
    // null only when the database has no principal; fetch-prompt-blocks.sh refuses that.
    principal_contact_id: stack.principalContactId ?? null,
    principal_identities: rc.principalIdentities.map((id) => ({
      channel: id.channel,
      channel_identifier: id.channelIdentifier,
      label: id.label ?? null,
    })),
    // null is legitimate for these three: no primary email set, no mailbox, no Signal.
    principal_primary_email: rc.principalPrimaryEmail.current ?? null,
    channel_accounts: {
      email: rc.channelAccounts.email ?? null,
      phone: rc.channelAccounts.phone ?? null,
    },
    // The stack's SkillRegistry holds exactly what production's reconcile enables.
    disabled_skills: discoveredSkillNames.filter((name) => !stack.skillRegistry.get(name)).sort(),
  };
}

function readCuriaVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('package.json has no version');
  }
  return pkg.version;
}

// Pin resolution warns once per pin it cannot resolve. MCP servers never load in the
// test-mode stack, so every MCP pin trips these on every run; stack.warnings already
// summarises unresolved pins, and pins do not affect any snapshot field.
const PIN_NOISE = [
  'Pinned skill expands to a tool that is not loaded',
  'Pinned skill not found in SkillRegistry',
];

/**
 * warn and above, to stderr. Not the silent logger: a vault read that fails mid-run is
 * only logged (readVaultKey, resolveEmailAccounts), and swallowing that would let a
 * snapshot with a missing Signal number or mailbox pass as healthy. Not createLogger():
 * under NODE_ENV=production it writes to stdout, which is the JSON.
 */
function stderrLogger(): Logger {
  return pino(
    {
      level: 'warn',
      hooks: {
        logMethod(args, method) {
          const msg = args.find((a): a is string => typeof a === 'string');
          if (msg && PIN_NOISE.some((noise) => msg.startsWith(noise))) return;
          method.apply(this, args);
        },
      },
    },
    // Synchronous, so a warning is flushed before process.exit on a fatal error.
    pino.destination({ dest: 2, sync: true }),
  );
}

async function main(): Promise<void> {
  if (!process.env.SECRET_ENCRYPTION_KEY) {
    throw new Error(
      'SECRET_ENCRYPTION_KEY is required: without the vault the Signal number and email grant ' +
        'check are missing, and the snapshot would not say so.',
    );
  }
  const stack = await createTestModeStack({ llm: 'offline', logger: stderrLogger() });
  try {
    // Ways the stack differs from production (unresolved pins, an unreadable calendar
    // grant). Pins and the calendar do not change any snapshot field.
    for (const warning of stack.warnings) {
      process.stderr.write(`inspect-prompts: warning: ${warning}\n`);
    }
    // Same directory the stack loads skills from (its default, <repo>/skills).
    const discovered = discoverSkillManifests(resolve(REPO_ROOT, 'skills')).map((d) => d.name);
    const snapshot = await buildPromptInputsSnapshot(stack, readCuriaVersion(), discovered);
    // process.stdout.write, not console.log — the caller parses this as JSON.
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
  } finally {
    try {
      await stack.shutdown();
    } catch (err: unknown) {
      // Don't let teardown shadow a real error — the snapshot may already be written.
      process.stderr.write(`inspect-prompts: warning: shutdown failed: ${inspect(err, { depth: 5 })}\n`);
    }
  }
}

// realpath: import.meta.url is the resolved path, argv[1] is as typed. Through a symlink
// (macOS /tmp → /private/tmp) a plain comparison is false, main() never runs, and the
// script prints nothing and exits 0 — an empty snapshot that looks like success.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err: unknown) => {
    // inspect, not String(): a refused connection is an AggregateError whose String() is
    // just "AggregateError", and String() drops `cause` and the stack.
    process.stderr.write(`inspect-prompts: fatal error\n${inspect(err, { depth: 5 })}\n`);
    process.exit(1);
  });
}
