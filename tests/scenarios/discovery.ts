// Tools an agent can reach through tool-registry discovery (#2050).
//
// The runtime adds every kind:'tool' hit of a tool-registry call to the agent's working
// tool list for the rest of the turn (src/agents/runtime.ts). A bundle's member tools
// come back as kind:'skill' and are loaded by skill-activate instead, which the harness
// already counts. Production's own search with an empty query matches every tool, so
// this is the same rule, not a copy of it.

import type { ToolRegistry } from '../../src/skills/registry.js';
import type { SkillRegistry } from '../../src/skills/skill-registry.js';
import { unifiedToolSearch } from '../../src/skills/skill-activation.js';

export function discoverableTools(
  toolRegistry: ToolRegistry,
  skillRegistry: SkillRegistry,
  agentId: string,
): string[] {
  return unifiedToolSearch({ query: '', toolRegistry, skillRegistry, agentId })
    .filter(hit => hit.kind === 'tool')
    .map(hit => hit.name);
}
