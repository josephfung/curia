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
  }>;
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

  // Validate required fields
  if (!config.name) {
    throw new Error(`Agent config at ${filePath} is missing required field: name`);
  }
  if (!config.model?.provider || !config.model?.model) {
    throw new Error(`Agent config '${config.name}' at ${filePath} is missing model.provider or model.model`);
  }
  if (!config.system_prompt) {
    throw new Error(`Agent config '${config.name}' at ${filePath} is missing system_prompt`);
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
 * - ${available_specialists} — list of specialist agents from the agent registry
 * - ${current_date} — today's date in the configured timezone (YYYY-MM-DD, Day)
 * - ${timezone} — the configured IANA timezone name
 * - ${agent_contact_id} — the agent's own contact ID (seeded at bootstrap)
 *
 * This runs at bootstrap time (after all agents are registered) and is separate
 * from persona interpolation which runs at config load time.
 */
export function interpolateRuntimeContext(
  systemPrompt: string,
  context: {
    availableSpecialists?: string;
    currentDate?: string;
    timezone?: string;
    agentContactId?: string;
  },
): string {
  return systemPrompt
    .replace(
      /\$\{available_specialists\}/g,
      context.availableSpecialists ?? 'No specialists available yet.',
    )
    .replace(
      /\$\{current_date\}/g,
      context.currentDate ?? new Date().toISOString().split('T')[0] ?? '',
    )
    .replace(
      /\$\{timezone\}/g,
      context.timezone ?? 'UTC',
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
