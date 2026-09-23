/**
 * Shared agent-name shape for YAML `name`, `tasks.source_agent_id`, and related
 * TEXT columns that hold agent identifiers (#1882).
 *
 * Enforced at agent load time (`loadAgentConfig`) so the roster cannot drift
 * from what `POST /api/kg/tasks` accepts. System writers (e.g. `health-service`)
 * must use the same character class.
 */
export const AGENT_NAME_MAX_LENGTH = 64;

/** Start with a letter; then lowercase letters, digits, or hyphens; max 64 chars. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export const AGENT_NAME_RULE =
  '1–64 chars, start with a letter, then lowercase letters, digits, or hyphens';

export function isAgentName(value: string): boolean {
  return AGENT_NAME_RE.test(value);
}
