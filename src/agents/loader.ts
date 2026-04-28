import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

// UUID v4 format: 8-4-4-4-12 hex groups separated by hyphens.
// Used to validate agentContactId before system prompt interpolation —
// guards against prompt injection if the ID source ever changes from
// the current gen_random_uuid() call in bootstrap.ts.
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape of an agent YAML config file.
 * Fields match what's in agents/*.yaml.
 */
export interface AgentYamlConfig {
  name: string;
  role?: string;
  description?: string;
  persona?: {
    display_name?: string;
    tone?: string;
    title?: string;
    email_signature?: string;
  };
  model: {
    provider: string;
    model: string;
    fallback?: {
      provider: string;
      model: string;
    };
  };
  system_prompt: string;
  pinned_skills?: string[];
  allow_discovery?: boolean;
  memory?: {
    scopes?: string[];
  };
  schedule?: Array<{
    cron: string;
    task: string;
    agent_id?: string;             // target agent for this job (defaults to config.name if omitted)
    /** Expected wall-clock duration in seconds. Drives stuck-job recovery timeout. */
    expectedDurationSeconds?: number;
  }>;
  /** Expected wall-clock duration for delegate calls targeting this agent, in seconds.
   *  When set, the runtime injects timeout_ms = expected_duration_seconds * 1000 into
   *  delegate calls that don't already carry an explicit timeout. */
  expected_duration_seconds?: number;
  error_budget?: {
    max_turns?: number;
    max_cost_usd?: number;
    max_errors?: number;
  };
}

/**
 * Load a single agent config from a YAML file.
 * Interpolates ${persona.*} placeholders in system_prompt.
 */
export function loadAgentConfig(filePath: string): AgentYamlConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read agent config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let config: AgentYamlConfig;
  try {
    config = yaml.load(raw) as AgentYamlConfig;
  } catch (err) {
    throw new Error(`Invalid YAML in agent config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Interpolate ${persona.*} placeholders in the system prompt.
  // The persona section is the single source of truth for display name, tone, etc.
  // Keeping them as references in system_prompt avoids duplication and makes
  // persona changes a one-field edit rather than a find-and-replace across the prompt.
  if (config.persona) {
    config.system_prompt = interpolatePersona(config.system_prompt, config.persona);
  }

  return config;
}

/**
 * Load all agent configs from a directory.
 * Reads every .yaml and .yml file in the directory.
 */
export function loadAllAgentConfigs(dirPath: string): AgentYamlConfig[] {
  const files = fs.readdirSync(dirPath)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  return files.map(f => loadAgentConfig(path.join(dirPath, f)));
}

/**
 * Replace ${persona.field_name} placeholders with actual values from the persona block.
 *
 * Why: The system_prompt is a template — it references persona.display_name
 * and persona.tone by name so agents can be "re-skinned" by editing only the
 * persona section, without touching the prose of the prompt.
 *
 * Unresolved placeholders (referencing fields not present in persona) are left
 * as-is rather than substituting empty string — a visible `${persona.unknown}`
 * in a response makes the misconfiguration obvious during development.
 */
function interpolatePersona(
  template: string,
  persona: NonNullable<AgentYamlConfig['persona']>,
): string {
  return template.replace(/\$\{persona\.(\w+)\}/g, (_match, field: string) => {
    const value = persona[field as keyof typeof persona];
    // Leave unresolved placeholders intact so misconfiguration is visible
    return value ?? `\${persona.${field}}`;
  });
}

/**
 * Interpolate runtime context placeholders in the system prompt.
 * Currently supports:
 * - ${office_identity_block} — compiled identity block from OfficeIdentityService
 * - ${executive_voice_block} — compiled writing voice block from ExecutiveProfileService
 * - ${available_specialists} — list of specialist agents from the agent registry
 * - ${current_date} — today's date in the configured timezone (YYYY-MM-DD, Day)
 * - ${timezone} — the configured IANA timezone name
 * - ${agent_contact_id} — the agent's own contact ID (seeded at bootstrap)
 *
 * This runs at bootstrap time (after all agents are registered) and is separate
 * from persona interpolation which runs at config load time.
 *
 * Note: ${executive_voice_block} is also replaced per-turn in runtime.ts (for hot
 * reload support), but the bootstrap-time pass here handles the static case and
 * ensures the placeholder is resolved even if the runtime injection path is skipped.
 */
export function interpolateRuntimeContext(
  systemPrompt: string,
  context: {
    availableSpecialists?: string;
    agentContactId?: string;
    officeIdentityBlock?: string;
    executiveVoiceBlock?: string;
  },
): string {
  return systemPrompt
    .replace(
      /\$\{office_identity_block\}/g,
      // The identity block is compiled by OfficeIdentityService.compileSystemPromptBlock().
      // It must be injected before persona tokens so constraints always appear first.
      // If the service is not yet initialized, leave the placeholder as-is so the
      // misconfiguration is visible rather than silently producing an empty block.
      context.officeIdentityBlock ?? '${office_identity_block}',
    )
    .replace(
      /\$\{executive_voice_block\}/g,
      // The voice block is compiled by ExecutiveProfileService.compileWritingVoiceBlock().
      // If the service is not initialized (non-fatal), the placeholder stays literal —
      // visible in LLM output as a misconfiguration signal, but not a hard failure.
      context.executiveVoiceBlock ?? '${executive_voice_block}',
    )
    .replace(
      /\$\{available_specialists\}/g,
      context.availableSpecialists ?? 'No specialists available yet.',
    )
    .replace(
      /\$\{agent_contact_id\}/g,
      // Validate UUID format before interpolation — defense-in-depth against
      // prompt injection if the ID source ever changes from gen_random_uuid().
      // The current bootstrap always produces a Postgres-generated UUID, but an
      // explicit check here ensures a future change (env var, config, etc.) can't
      // accidentally inject arbitrary text into the system prompt.
      UUID_FORMAT.test(context.agentContactId ?? '') ? (context.agentContactId ?? '') : '',
    );
}
